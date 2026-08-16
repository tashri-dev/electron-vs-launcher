const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20000;
const GIT_FETCH_TIMEOUT_MS = 120000;
const GIT_FETCH_CONCURRENCY = 4;
const GIT_CHECKOUT_CONCURRENCY = 4;
const SWITCHABLE_BRANCHES = ["master_dev", "master_sit", "master_uat", "master_oci"];
const SWITCHABLE_BRANCH_SET = new Set(SWITCHABLE_BRANCHES);

/** @type {Map<string, Set<HTMLSelectElement>>} */
const branchSelectsByRepo = new Map();
/** @type {Map<string, { branches: string[], current: string }>} */
const branchStateByRepo = new Map();
let globalBranchRefreshTimer = null;

/** Migrated once to user-settings.json (userData); safe to remove later */
const LEGACY_ROOT_PATH_STORAGE_KEY = "electron-vs-launcher-root-path";

let effectiveRootPath = "";

function getDefaultRootPath() {
  return path.join(os.homedir(), "git-repos", "amwal-pay") + path.sep;
}

function normalizeRootPathString(raw) {
  let s = String(raw ?? "").trim();
  if (!s) {
    return getDefaultRootPath();
  }
  if (
    s === "~" ||
    s.startsWith("~/") ||
    s.startsWith("~\\") ||
    s.startsWith("~" + path.sep)
  ) {
    const rest = s === "~" ? "" : s.slice(2);
    s = path.join(os.homedir(), rest);
  }
  const abs = path.resolve(s);
  return abs.endsWith(path.sep) ? abs : abs + path.sep;
}

function resolveConfiguredRootPath(configRootPath) {
  const trimmed = String(configRootPath ?? "").trim();
  if (!trimmed) {
    return getDefaultRootPath();
  }
  return normalizeRootPathString(trimmed);
}

function getEffectiveRootPath(configRootPath, userRootPathOverride) {
  if (
    userRootPathOverride != null &&
    String(userRootPathOverride).trim() !== ""
  ) {
    return normalizeRootPathString(userRootPathOverride);
  }
  return resolveConfiguredRootPath(configRootPath);
}

async function migrateLegacyRootPathFromLocalStorage(ipcRenderer, userSettings) {
  if (userSettings?.rootPath && String(userSettings.rootPath).trim() !== "") {
    return userSettings;
  }
  let legacy = null;
  try {
    legacy = localStorage.getItem(LEGACY_ROOT_PATH_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
  if (legacy && String(legacy).trim() !== "") {
    await ipcRenderer.invoke("app:set-user-settings", { rootPath: legacy });
    try {
      localStorage.removeItem(LEGACY_ROOT_PATH_STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
    return ipcRenderer.invoke("app:get-user-settings");
  }
  return userSettings;
}

function formatErrorReason(err) {
  if (err == null) {
    return "Unknown error";
  }
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message || String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function formatGitExecError(error, stderr) {
  const errText = String(stderr ?? "").trim();
  if (errText) {
    return errText;
  }
  const message = formatErrorReason(error);
  return message.replace(/^Command failed: [^\n]+\n?/, "").trim() || message;
}

async function gitExec(repoDir, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", repoDir, ...args], {
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    throw new Error(formatGitExecError(error, error.stderr));
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const pending = new Set();
  for (const item of items) {
    const task = Promise.resolve()
      .then(() => worker(item))
      .finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= concurrency) {
      await Promise.race(pending);
    }
  }
  await Promise.all(pending);
}

function parseGitRefNames(stdout) {
  const seen = new Set();
  const branches = [];
  for (const raw of String(stdout).split("\n")) {
    let name = raw.trim();
    if (!name || name === "HEAD" || name.endsWith("/HEAD")) {
      continue;
    }
    if (name.startsWith("origin/")) {
      name = name.slice("origin/".length);
    } else if (name.startsWith("remotes/origin/")) {
      name = name.slice("remotes/origin/".length);
    } else if (name.startsWith("remotes/")) {
      const parts = name.split("/");
      if (parts.length >= 3) {
        name = parts.slice(2).join("/");
      }
    }
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    branches.push(name);
  }
  return branches;
}

async function listGitBranches(repoDir) {
  const [{ stdout: currentRaw }, { stdout: refsRaw }] = await Promise.all([
    gitExec(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitExec(repoDir, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ]),
  ]);
  const current = currentRaw.trim();
  const found = new Set(parseGitRefNames(refsRaw));
  if (current) {
    found.add(current);
  }
  const branches = SWITCHABLE_BRANCHES.filter((branch) => found.has(branch));
  return { branches, current };
}

function setBranchSelectPlaceholder(select, text) {
  select.replaceChildren();
  const option = document.createElement("option");
  option.value = "";
  option.textContent = text;
  select.appendChild(option);
  select.disabled = true;
  select._currentBranch = "";
}

function fillBranchSelect(select, branches, current) {
  select.replaceChildren();
  const currentSwitchable = SWITCHABLE_BRANCH_SET.has(current);

  if (current && !currentSwitchable) {
    const other = document.createElement("option");
    other.value = "";
    other.textContent = current;
    other.disabled = true;
    other.selected = true;
    select.appendChild(other);
  }

  for (const branch of branches) {
    const option = document.createElement("option");
    option.value = branch;
    option.textContent = branch;
    if (currentSwitchable && branch === current) {
      option.selected = true;
    }
    select.appendChild(option);
  }
  select._currentBranch = current || "";
  select.disabled = branches.length === 0;
  select.title = current ? `Current branch: ${current}` : "Switch git branch";
}

function registerBranchSelect(repoDir, select) {
  if (!branchSelectsByRepo.has(repoDir)) {
    branchSelectsByRepo.set(repoDir, new Set());
  }
  branchSelectsByRepo.get(repoDir).add(select);
}

async function loadBranchesIntoSelect(select, repoDir) {
  setBranchSelectPlaceholder(select, "Loading…");
  try {
    const { branches, current } = await listGitBranches(repoDir);
    branchStateByRepo.set(repoDir, { branches, current });
    if (branches.length === 0) {
      setBranchSelectPlaceholder(select, "No branches");
      scheduleRefreshGlobalBranchSelect();
      return;
    }
    fillBranchSelect(select, branches, current);
  } catch (err) {
    branchStateByRepo.delete(repoDir);
    setBranchSelectPlaceholder(select, "Unavailable");
    select.title = formatErrorReason(err);
  }
  scheduleRefreshGlobalBranchSelect();
}

function scheduleRefreshGlobalBranchSelect() {
  if (globalBranchRefreshTimer) {
    clearTimeout(globalBranchRefreshTimer);
  }
  globalBranchRefreshTimer = setTimeout(() => {
    globalBranchRefreshTimer = null;
    refreshGlobalBranchSelect();
  }, 80);
}

function refreshGlobalBranchSelect() {
  const select = document.getElementById("globalBranchSelect");
  if (!select || select.dataset.switching === "1") {
    return;
  }

  const states = [...branchStateByRepo.values()];
  if (states.length === 0) {
    setBranchSelectPlaceholder(select, "No branches");
    return;
  }

  const counts = new Map();
  const currents = new Set();
  for (const { branches, current } of states) {
    if (current) {
      currents.add(current);
    }
    for (const branch of branches) {
      counts.set(branch, (counts.get(branch) || 0) + 1);
    }
  }

  const allBranches = SWITCHABLE_BRANCHES.filter((branch) => counts.has(branch));
  const uniqueCurrents = [...currents];
  const commonCurrent =
    uniqueCurrents.length === 1 && SWITCHABLE_BRANCH_SET.has(uniqueCurrents[0])
      ? uniqueCurrents[0]
      : "";
  fillGlobalBranchSelect(select, allBranches, commonCurrent, states.length, counts);
}

function fillGlobalBranchSelect(select, branches, current, repoCount, counts) {
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = current ? "Switch all to…" : "Mixed branches";
  select.appendChild(placeholder);

  for (const branch of branches) {
    const option = document.createElement("option");
    option.value = branch;
    const n = counts.get(branch) || 0;
    option.textContent = n === repoCount ? branch : `${branch} (${n})`;
    if (branch === current) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  if (!current) {
    placeholder.selected = true;
  }

  select.disabled = branches.length === 0;
  select._currentBranch = current || "";
  select.title = current
    ? `All repositories on ${current}`
    : "Repositories are on different branches";
}

async function onGlobalBranchChange() {
  const select = document.getElementById("globalBranchSelect");
  if (!select) {
    return;
  }

  const branch = select.value;
  const prev = select._currentBranch || "";
  if (!branch || branch === prev || !SWITCHABLE_BRANCH_SET.has(branch)) {
    if (!branch || !SWITCHABLE_BRANCH_SET.has(branch)) {
      refreshGlobalBranchSelect();
    }
    return;
  }

  const targets = collectUniqueRepoTargets();
  if (targets.length === 0) {
    showToast("No repositories found to switch", "info");
    refreshGlobalBranchSelect();
    return;
  }

  select.disabled = true;
  select.dataset.switching = "1";
  showToast(
    `Switching ${targets.length} ${targets.length === 1 ? "repo" : "repos"} to ${branch}…`,
    "info"
  );

  const failures = [];
  let succeeded = 0;
  let skipped = 0;

  try {
    await runWithConcurrency(targets, GIT_CHECKOUT_CONCURRENCY, async ({ repoDir, name }) => {
      if (branchStateByRepo.get(repoDir)?.current === branch) {
        skipped += 1;
        return;
      }
      try {
        await gitExec(repoDir, ["checkout", branch]);
        succeeded += 1;
        await Promise.all(
          [...(branchSelectsByRepo.get(repoDir) || [])].map((el) =>
            loadBranchesIntoSelect(el, repoDir)
          )
        );
      } catch (err) {
        failures.push({ name, error: formatErrorReason(err) });
      }
    });
  } finally {
    select.dataset.switching = "0";
    refreshGlobalBranchSelect();
  }

  if (failures.length === 0) {
    if (succeeded === 0 && skipped > 0) {
      showToast(`All repos already on ${branch}`, "info");
      return;
    }
    const extra = skipped > 0 ? ` (${skipped} already on it)` : "";
    showToast(`Switched ${succeeded} ${succeeded === 1 ? "repo" : "repos"} to ${branch}${extra}`, "success");
    return;
  }

  const detail = failures
    .slice(0, 8)
    .map((item) => `${item.name}: ${item.error}`)
    .join("\n");
  const extra =
    failures.length > 8 ? `\n…and ${failures.length - 8} more` : "";
  showToast(
    `Switched ${succeeded} of ${targets.length} repos to ${branch}\n${detail}${extra}`,
    succeeded > 0 ? "info" : "error"
  );
}

function refreshBranchSelectsForRepo(repoDir) {
  const selects = branchSelectsByRepo.get(repoDir);
  if (!selects) {
    return;
  }
  selects.forEach((select) => {
    loadBranchesIntoSelect(select, repoDir);
  });
}

async function onBranchSelectChange(select, repoDir, name) {
  const next = select.value;
  const prev = select._currentBranch || "";
  if (!next || next === prev || !SWITCHABLE_BRANCH_SET.has(next)) {
    return;
  }

  select.disabled = true;
  try {
    await gitExec(repoDir, ["checkout", next]);
    showToast(`Switched ${name} to ${next}`, "success");
    await Promise.all(
      [...(branchSelectsByRepo.get(repoDir) || [])].map((el) =>
        loadBranchesIntoSelect(el, repoDir)
      )
    );
  } catch (err) {
    showToast(
      `Could not switch branch (${name}):\n${formatErrorReason(err)}`,
      "error"
    );
    select.value = prev;
    select.disabled = false;
  }
}

function createBranchCell(solution, rootPath) {
  const td = document.createElement("td");
  const select = document.createElement("select");
  select.classList.add("form-select", "form-select-sm", "app-branch-select");
  select.setAttribute("aria-label", `Git branch for ${solution.name}`);
  select.title = "Switch git branch";
  setBranchSelectPlaceholder(select, "Loading…");
  td.appendChild(select);

  const target = resolveGetLatestTarget(solution.solutionPath, rootPath);
  if (target.error) {
    setBranchSelectPlaceholder(select, "Unavailable");
    select.title =
      typeof target.error === "string"
        ? target.error
        : formatErrorReason(target.error);
    return td;
  }

  select.dataset.repoDir = target.repoDir;
  select.dataset.solutionName = solution.name;
  registerBranchSelect(target.repoDir, select);
  select.addEventListener("change", () => {
    onBranchSelectChange(select, target.repoDir, solution.name);
  });
  loadBranchesIntoSelect(select, target.repoDir);
  return td;
}

function resolveGetLatestTarget(solutionPath, rootPath) {
  const normalized = path.isAbsolute(solutionPath)
    ? solutionPath
    : path.join(rootPath, solutionPath);

  if (!fs.existsSync(normalized)) {
    return { error: `Path does not exist:\n${normalized}` };
  }

  try {
    const st = fs.statSync(normalized);
    const repoDir = st.isDirectory() ? normalized : path.dirname(normalized);
    return {
      repoDir,
      name: path.basename(normalized),
    };
  } catch (err) {
    return { error: err, context: "Cannot read path" };
  }
}

const getLatestInFlight = new Set();

function updateToastToolbar() {
  const host = document.getElementById("toastHost");
  const toolbar = document.getElementById("toastToolbar");
  if (!host || !toolbar) {
    return;
  }
  toolbar.hidden = host.querySelectorAll(".app-toast").length === 0;
}

function dismissToast(el) {
  if (!el || el.classList.contains("app-toast--out")) {
    return;
  }
  el.classList.add("app-toast--out");
  setTimeout(() => {
    el.remove();
    updateToastToolbar();
  }, 280);
}

function clearAllToasts() {
  const host = document.getElementById("toastHost");
  if (!host) {
    return;
  }
  host.querySelectorAll(".app-toast").forEach(dismissToast);
}

function showToast(message, kind = "error") {
  const host = document.getElementById("toastHost");
  if (!host) {
    return;
  }
  const text = String(message ?? "").trim() || "Something went wrong.";
  const el = document.createElement("div");
  el.className = `app-toast app-toast--${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");

  const iconWrap = document.createElement("span");
  iconWrap.className = "app-toast__icon";
  iconWrap.setAttribute("aria-hidden", "true");
  const icon = document.createElement("i");
  icon.className =
    kind === "success"
      ? "fa fa-check-circle"
      : kind === "info"
        ? "fa fa-info-circle"
        : "fa fa-exclamation-circle";
  iconWrap.appendChild(icon);

  const body = document.createElement("span");
  body.className = "app-toast__body";
  body.textContent = text;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "app-toast__close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.innerHTML = '<i class="fa fa-times" aria-hidden="true"></i>';

  el.appendChild(iconWrap);
  el.appendChild(body);
  el.appendChild(closeBtn);

  closeBtn.addEventListener("click", () => dismissToast(el));
  host.appendChild(el);
  host.scrollTop = host.scrollHeight;
  updateToastToolbar();
}

function toastError(err, context) {
  const reason = formatErrorReason(err);
  const msg = context ? `${context}: ${reason}` : reason;
  console.error(context || "Error", err);
  showToast(msg, "error");
}

(function initGlobalErrorToasts() {
  window.addEventListener("error", (event) => {
    if (event.target && event.target !== window) {
      return;
    }
    const detail =
      event.error instanceof Error
        ? event.error
        : event.message || event.error || "Uncaught error";
    toastError(detail, "Uncaught error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    toastError(event.reason, "Unhandled promise rejection");
  });

  document.getElementById("clearToastsBtn")?.addEventListener("click", clearAllToasts);
})();

const THEME_STORAGE_KEY = "electron-vs-launcher-theme";

function getStoredThemePreference() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") {
      return v;
    }
  } catch (_) {
    /* ignore */
  }
  return "system";
}

function setStoredThemePreference(pref) {
  if (pref !== "light" && pref !== "dark" && pref !== "system") {
    return;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch (_) {
    /* ignore */
  }
}

function resolveAppliedTheme() {
  const pref = getStoredThemePreference();
  if (pref === "light") {
    return "light";
  }
  if (pref === "dark") {
    return "dark";
  }
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

function applyDocumentTheme() {
  document.documentElement.setAttribute("data-theme", resolveAppliedTheme());
}

function syncThemePreferenceSelect() {
  const sel = document.getElementById("themePreferenceSelect");
  if (sel) {
    sel.value = getStoredThemePreference();
  }
}

(function initThemePreferenceListeners() {
  applyDocumentTheme();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getStoredThemePreference() === "system") {
      applyDocumentTheme();
    }
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
  } else if (typeof mq.addListener === "function") {
    mq.addListener(onChange);
  }
})();

document
  .getElementById("launchBtnForIDE")
  .addEventListener("click", launchSelectedSolutionsSafely);

  document
  .getElementById("launchBtnForCLI")
  .addEventListener("click", launchSelectedSolutionsOnCLI);


document.getElementById("clearBtn").addEventListener("click", clearSelections);
document
  .getElementById("selectAllBtn")
  .addEventListener("click", selectAllCheckboxes);
document.getElementById('get-latest-selected').addEventListener('click', getLatestFromSelected);
document.getElementById("fetchAllBtn").addEventListener("click", fetchAllRepos);
document
  .getElementById("globalBranchSelect")
  .addEventListener("change", onGlobalBranchChange);

const riderPath = "/Applications/Rider.app/Contents/MacOS/rider";

// Check if Rider is already running
function isRiderRunning(callback) {
  const ps = spawn("pgrep", ["-f", "Rider"]);
  ps.on("error", (err) => {
    toastError(err, "Could not check if Rider is running");
    callback(false);
  });
  ps.on("close", (code) => {
    callback(code === 0); // 0 = found process
  });
}

// Launch Rider without a project to ensure it's initialized
function preWarmRider() {
  const child = spawn(riderPath, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (err) => {
    toastError(err, "Could not start Rider");
  });
  child.unref();
}

// Launch a single solution in Rider
function launchSolution(solutionPath) {
  if (!fs.existsSync(solutionPath)) {
    showToast(`Solution path does not exist:\n${solutionPath}`, "error");
    return;
  }

  const args = [solutionPath];

  const options = {
    detached: true,
    stdio: "ignore"
  };

  const child = spawn(riderPath, args, options);
  child.on("error", (err) => {
    toastError(err, "Could not open solution in Rider");
  });
  child.unref();

  console.log(`Launched Rider for: ${solutionPath}`);
}

// Launch selected checkboxes
function launchSelectedSolutions() {
  document
    .querySelectorAll('input[type="checkbox"]:checked')
    .forEach((checkbox) => {
      launchSolution(checkbox.value);
    });
}


// Launch selected checkboxes
function launchSelectedSolutionsOnCLI() {
  document
    .querySelectorAll('input[type="checkbox"]:checked')
    .forEach((checkbox) => {
      launchOnCLI(
        checkbox.data,
        checkbox._category,
        checkbox._npmScript,
        checkbox._aspnetCoreEnvironment,
        checkbox._aspnetCoreUrls
      );
    });
}

// Entry point — ensures Rider is warmed before launching projects
function launchSelectedSolutionsSafely() {
  isRiderRunning((running) => {
    if (!running) {
      console.log("Rider is not running. Launching in background...");
      preWarmRider();

      // Wait 3 seconds to allow it to boot up before launching solutions
      setTimeout(() => {
        launchSelectedSolutions();
      }, 3000);
    } else {
      console.log("Rider is already running. Launching solutions immediately.");
      launchSelectedSolutions();
    }
  });
}


function collectUniqueRepoTargets() {
  const seen = new Map();
  document
    .querySelectorAll('#solutionsContainer input[type="checkbox"]')
    .forEach((checkbox) => {
      const target = resolveGetLatestTarget(checkbox.value, effectiveRootPath);
      if (target.error || seen.has(target.repoDir)) {
        return;
      }
      const labelName = checkbox.nextElementSibling?.textContent?.trim();
      seen.set(target.repoDir, {
        repoDir: target.repoDir,
        name: labelName || target.name,
      });
    });
  return [...seen.values()];
}

let fetchAllInFlight = false;

async function fetchAllRepos() {
  if (fetchAllInFlight) {
    showToast("Fetch all is already running", "info");
    return;
  }

  const targets = collectUniqueRepoTargets();
  if (targets.length === 0) {
    showToast("No repositories found to fetch", "info");
    return;
  }

  fetchAllInFlight = true;
  const btn = document.getElementById("fetchAllBtn");
  const originalHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin me-1" aria-hidden="true"></i> Fetching…';
  }

  showToast(
    `Fetching ${targets.length} ${targets.length === 1 ? "repo" : "repos"}…`,
    "info"
  );

  const failures = [];
  let succeeded = 0;

  try {
    await runWithConcurrency(targets, GIT_FETCH_CONCURRENCY, async ({ repoDir, name }) => {
      try {
        await gitExec(repoDir, ["fetch", "--all", "--prune"], {
          timeout: GIT_FETCH_TIMEOUT_MS,
        });
        succeeded += 1;
        refreshBranchSelectsForRepo(repoDir);
      } catch (err) {
        failures.push({ name, error: formatErrorReason(err) });
      }
    });
  } finally {
    fetchAllInFlight = false;
    if (btn) {
      btn.disabled = false;
      if (originalHtml) {
        btn.innerHTML = originalHtml;
      }
    }
  }

  if (failures.length === 0) {
    showToast(
      `Fetched ${succeeded} ${succeeded === 1 ? "repo" : "repos"}`,
      "success"
    );
    return;
  }

  const detail = failures
    .slice(0, 8)
    .map((item) => `${item.name}: ${item.error}`)
    .join("\n");
  const extra =
    failures.length > 8 ? `\n…and ${failures.length - 8} more` : "";
  showToast(
    `Fetched ${succeeded} of ${targets.length} repos\n${detail}${extra}`,
    succeeded > 0 ? "info" : "error"
  );
}

function getLatestFromSelected() {
  const seenRepoDirs = new Set();

  document
    .querySelectorAll('input[type="checkbox"]:checked')
    .forEach((checkbox) => {
      const target = resolveGetLatestTarget(checkbox.value, effectiveRootPath);
      if (target.error) {
        if (target.context) {
          toastError(target.error, target.context);
        } else {
          showToast(target.error, "error");
        }
        return;
      }
      if (seenRepoDirs.has(target.repoDir)) {
        return;
      }
      seenRepoDirs.add(target.repoDir);
      runGetLatest(target.repoDir, target.name);
    });
}


function warmUpRider() {
  const riderPath = "/Applications/Rider.app/Contents/MacOS/rider";

  const child = spawn(riderPath, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function clearSelections() {
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((checkbox) => {
    checkbox.checked = false;
  });
}
function selectAllCheckboxes() {
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((checkbox) => {
    checkbox.checked = true;
  });
}


function getSelectedBranchForRepo(repoDir) {
  const state = branchStateByRepo.get(repoDir);
  if (state?.current) {
    return state.current;
  }
  const selects = branchSelectsByRepo.get(repoDir);
  if (selects) {
    for (const select of selects) {
      const branch = select._currentBranch || select.value;
      if (branch) {
        return branch;
      }
    }
  }
  return "";
}

async function resolveBranchForGetLatest(repoDir) {
  const selected = String(getSelectedBranchForRepo(repoDir) || "").trim();
  if (selected) {
    return selected;
  }
  const { stdout } = await gitExec(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const current = stdout.trim();
  if (!current || current === "HEAD") {
    throw new Error("Could not determine the selected branch");
  }
  return current;
}

function getLatest(solutionPath, rootPath) {
  const target = resolveGetLatestTarget(solutionPath, rootPath);
  if (target.error) {
    if (target.context) {
      toastError(target.error, target.context);
    } else {
      showToast(target.error, "error");
    }
    return;
  }
  runGetLatest(target.repoDir, target.name);
}

async function runGetLatest(repoDir, name) {
  if (getLatestInFlight.has(repoDir)) {
    showToast(`Get latest already running for ${name}`, "info");
    return;
  }

  getLatestInFlight.add(repoDir);

  try {
    const branch = await resolveBranchForGetLatest(repoDir);
    await gitExec(repoDir, ["checkout", branch]);
    const { stdout, stderr } = await gitExec(repoDir, ["pull"], {
      timeout: GIT_FETCH_TIMEOUT_MS,
    });
    const okMsg = [stdout, stderr].filter(Boolean).join("").trim();
    showToast(
      okMsg
        ? `Get latest: ${name} (${branch})\n${okMsg}`
        : `Get latest succeeded: ${name} (${branch})`,
      "success"
    );
    refreshBranchSelectsForRepo(repoDir);
  } catch (err) {
    showToast(
      `Get latest failed (${name}):\n${formatErrorReason(err)}`,
      "error"
    );
  } finally {
    getLatestInFlight.delete(repoDir);
  }
}

function showNotification(title, message, state) {
  const kind =
    state === "success" ? "success" : state === "error" ? "error" : "info";
  const combined = [title, message].filter(Boolean).join(" ").trim();
  showToast(combined || title || "Notice", kind);
}

function updateDb(migratorRelativePath) {
  try {
    const dotnetPath = "/usr/local/share/dotnet/dotnet";
    const migratorProjectPath = path.resolve(__dirname, migratorRelativePath);

    if (!fs.existsSync(dotnetPath) || fs.lstatSync(dotnetPath).isDirectory()) {
      showToast("Invalid .NET SDK path: /usr/local/share/dotnet/dotnet", "error");
      return;
    }
    if (!fs.existsSync(migratorProjectPath) || fs.lstatSync(migratorProjectPath).isDirectory()) {
      showToast("Invalid migrator project: expected a .csproj file.", "error");
      return;
    }

    // AppleScript to open Terminal and run the command
    const command = `"${dotnetPath}" run --project "${migratorProjectPath}"; echo; echo 'Press any key to exit...'; read -n 1`;
    const osaScript = [
      'tell application "Terminal"',
      `do script "${command.replace(/(["\\$`])/g, '\\$1')}"`,
      'activate',
      'end tell'
    ].join('\n');

    spawn('osascript', ['-e', osaScript], {
      detached: true,
      stdio: "ignore"
    }).unref();
  } catch (e) {
    toastError(e, "Update DB");
  }
}




function launchOnCLI(
  startupProject,
  category,
  npmScript,
  aspnetCoreEnvironment,
  aspnetCoreUrls
) {
  try {
    const startupProjectPath = path.resolve(startupProject);
    const cat = category || "dotnet";

    if (cat === "node") {
      if (!fs.existsSync(startupProjectPath) || !fs.statSync(startupProjectPath).isDirectory()) {
        showToast("Node projects require startupProject to be an existing directory.", "error");
        return;
      }
      const script = npmScript || "start";
      const command = `cd "${startupProjectPath}" && npm run ${script}; echo; echo 'Press any key to exit...'; read -n 1`;
      const osaScript = [
        'tell application "Terminal"',
        `do script "${command.replace(/(["\\$`])/g, '\\$1')}"`,
        'activate',
        'end tell'
      ].join('\n');

      spawn('osascript', ['-e', osaScript], {
        detached: true,
        stdio: "ignore"
      }).unref();
      return;
    }

    const dotnetPath = "/usr/local/share/dotnet/dotnet";

    if (!fs.existsSync(dotnetPath) || fs.lstatSync(dotnetPath).isDirectory()) {
      showToast("Invalid .NET SDK path: /usr/local/share/dotnet/dotnet", "error");
      return;
    }
    if (!fs.existsSync(startupProjectPath) || fs.lstatSync(startupProjectPath).isDirectory()) {
      showToast("Expected a .csproj file for Run in console.", "error");
      return;
    }

    let envExports = "";
    if (aspnetCoreEnvironment) {
      envExports += `export ASPNETCORE_ENVIRONMENT="${aspnetCoreEnvironment}"; `;
    }
    if (aspnetCoreUrls) {
      envExports += `export ASPNETCORE_URLS="${aspnetCoreUrls}"; `;
    }

    // AppleScript to open Terminal and run the command
    const command = `${envExports}"${dotnetPath}" run --project "${startupProjectPath}"; echo; echo 'Press any key to exit...'; read -n 1`;
    const osaScript = [
      'tell application "Terminal"',
      `do script "${command.replace(/(["\\$`])/g, '\\$1')}"`,
      'activate',
      'end tell'
    ].join('\n');

    spawn('osascript', ['-e', osaScript], {
      detached: true,
      stdio: "ignore"
    }).unref();
  } catch (e) {
    toastError(e, "Run in CLI");
  }
}


function createSolutionsTable(solutions, rootPath) {
  const tableWrapper = document.createElement("div");
  tableWrapper.classList.add("table-responsive");

  const table = document.createElement("table");
  table.classList.add("table", "table-striped", "table-hover", "align-middle");

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const nameHeader = document.createElement("th");
  nameHeader.textContent = "Solution Name";
  nameHeader.classList.add("text-nowrap");

  const branchHeader = document.createElement("th");
  branchHeader.textContent = "Branch";
  branchHeader.classList.add("text-nowrap");

  const getLatestHeader = document.createElement("th");
  getLatestHeader.textContent = "Get Latest";
  getLatestHeader.classList.add("text-nowrap");

  const updateDbHeader = document.createElement("th");
  updateDbHeader.textContent = "Update DB";
  updateDbHeader.classList.add("text-nowrap");

  const runInConsoleHeader = document.createElement("th");
  runInConsoleHeader.textContent = "Run In Console";
  runInConsoleHeader.classList.add("text-nowrap");

  const dockerizeHeader = document.createElement("th");
  dockerizeHeader.textContent = "Dockerize";
  dockerizeHeader.classList.add("text-nowrap");

  headerRow.appendChild(nameHeader);
  headerRow.appendChild(branchHeader);
  headerRow.appendChild(getLatestHeader);
  headerRow.appendChild(updateDbHeader);
  headerRow.appendChild(runInConsoleHeader);
  headerRow.appendChild(dockerizeHeader);
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");

  solutions.forEach((solution) => {
    const row = document.createElement("tr");

    const checkboxTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.classList.add("form-check-input");
    checkbox.id = solution.name.replace(/\s/g, "");
    checkbox.value = path.join(rootPath, solution.solutionPath);
    checkbox.data = path.join(rootPath, solution.startupProject);
    checkbox._category = solution.category || "dotnet";
    checkbox._npmScript = solution.npmScript || "start";
    checkbox._aspnetCoreEnvironment = solution.aspnetCoreEnvironment || "";
    checkbox._aspnetCoreUrls = solution.aspnetCoreUrls || "";


    const label = document.createElement("label");
    label.classList.add("form-check-label", "ms-2");
    label.htmlFor = checkbox.id;
    label.textContent = solution.name;

    checkboxTd.appendChild(checkbox);
    checkboxTd.appendChild(label);
    checkboxTd.classList.add("text-nowrap");

    // Get Latest button column
    const getLatestTd = document.createElement("td");
    getLatestTd.classList.add("text-nowrap");
    const getLatestButton = document.createElement("button");
    getLatestButton.classList.add("btn", "btn-secondary", "btn-sm");
    getLatestButton.innerHTML = '<i class="fa fa-solid fa-download"></i>';
    getLatestButton.onclick = () => getLatest(solution.solutionPath,rootPath);
    getLatestTd.appendChild(getLatestButton);

    // Update DB button column
    const updateDbTd = document.createElement("td");
    updateDbTd.classList.add("text-nowrap");
    if (solution?.migratorPath != null) {
      const updateDbEl = document.createElement("button");
      updateDbEl.classList.add("btn", "btn-warning", "btn-sm");
      updateDbEl.textContent = "Update DB";
      updateDbEl.onclick = () => updateDb(path.join(rootPath, solution.migratorPath));
      updateDbTd.appendChild(updateDbEl);
    }

    // Run In Console button column
    const runInConsoleTd = document.createElement("td");
    runInConsoleTd.classList.add("text-nowrap");
    if (solution?.startupProject != null) {
      const runInConsoleEl = document.createElement("button");
      runInConsoleEl.classList.add("btn", "btn-success", "btn-sm");
      runInConsoleEl.textContent = "Run In Console";
      runInConsoleEl.onclick = () =>
        launchOnCLI(
          path.join(rootPath, solution.startupProject),
          solution.category,
          solution.npmScript,
          solution.aspnetCoreEnvironment,
          solution.aspnetCoreUrls
        );
      runInConsoleTd.appendChild(runInConsoleEl);
    }

    // Dockerize button column
    const dockerizeTd = document.createElement("td");
    dockerizeTd.classList.add("text-nowrap");
    if (solution.contextFolder) {
      const dockerizeButton = document.createElement("button");
      dockerizeButton.classList.add("btn", "btn-primary", "btn-sm");
      dockerizeButton.textContent = "Dockerize";
      dockerizeButton.onclick = () => dockerizeApp(solution, rootPath);
      dockerizeTd.appendChild(dockerizeButton);
    }

    row.appendChild(checkboxTd);
    row.appendChild(createBranchCell(solution, rootPath));
    row.appendChild(getLatestTd);
    row.appendChild(updateDbTd);
    row.appendChild(runInConsoleTd);
    row.appendChild(dockerizeTd);

    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);

  tableWrapper.appendChild(table);
  return tableWrapper;
}

function loadSolutionsFromConfig(config) {
  const solutionsContainer = document.getElementById("solutionsContainer");
  solutionsContainer.replaceChildren();
  branchSelectsByRepo.clear();
  branchStateByRepo.clear();
  scheduleRefreshGlobalBranchSelect();

  const rootPath = config.rootPath;

  let sectionsToRender = [];
  if (Array.isArray(config.sections) && config.sections.length > 0) {
    sectionsToRender = config.sections.filter(
      (s) => s.solutions && s.solutions.length > 0
    );
  } else if (Array.isArray(config.solutions) && config.solutions.length > 0) {
    sectionsToRender = [{ title: "Solutions", solutions: config.solutions }];
  }

  if (sectionsToRender.length === 0) {
    return;
  }

  const accordion = document.createElement("div");
  accordion.className = "accordion app-accordion";
  accordion.id = "solutionsAccordion";

  sectionsToRender.forEach((section, index) => {
    const collapseId = `section-collapse-${index}`;
    const headingId = `section-heading-${index}`;

    const item = document.createElement("div");
    item.className = "accordion-item";

    const headerWrap = document.createElement("h2");
    headerWrap.className = "accordion-header";
    headerWrap.id = headingId;

    const isOpen = index === 0;
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = isOpen
      ? "accordion-button"
      : "accordion-button collapsed";
    toggleBtn.setAttribute("data-bs-toggle", "collapse");
    toggleBtn.setAttribute("data-bs-target", "#" + collapseId);
    toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggleBtn.setAttribute("aria-controls", collapseId);
    toggleBtn.textContent = section.title || "Solutions";

    headerWrap.appendChild(toggleBtn);

    const collapse = document.createElement("div");
    collapse.id = collapseId;
    collapse.className = isOpen
      ? "accordion-collapse collapse show"
      : "accordion-collapse collapse";
    collapse.setAttribute("data-bs-parent", "#solutionsAccordion");

    const body = document.createElement("div");
    body.className = "accordion-body";

    const toolbar = document.createElement("div");
    toolbar.className = "d-flex justify-content-end mb-2";
    const selectSectionBtn = document.createElement("button");
    selectSectionBtn.type = "button";
    selectSectionBtn.className = "btn btn-outline-primary btn-sm";
    selectSectionBtn.innerHTML =
      '<i class="fa fa-check-square-o me-1"></i> Select all in section';
    selectSectionBtn.addEventListener("click", () => {
      body.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.checked = true;
      });
    });
    toolbar.appendChild(selectSectionBtn);
    body.appendChild(toolbar);
    body.appendChild(createSolutionsTable(section.solutions, rootPath));

    collapse.appendChild(body);
    item.appendChild(headerWrap);
    item.appendChild(collapse);
    accordion.appendChild(item);
  });

  solutionsContainer.appendChild(accordion);
}

function dockerizeApp(solution, rootPath) {
  const dockerFilePath = path.join(rootPath, solution.contextFolder, "dev-dockerfile");
  const dockerBuildCommand = `docker buildx build --pull --rm -t ${solution.imageContainerName}:latest -f ${dockerFilePath} ${path.join(rootPath, solution.contextFolder)}`;
  const dockerRunCommand = `docker run -d -p ${solution.dockerPort}:${solution.dockerPort} --name ${solution.imageContainerName} ${solution.imageContainerName}`;
  const dockerPruneCommand = `docker image prune -f`;

  const buildOptions = { shell: true, stdio: 'inherit' };
  const buildProcess = spawn('/bin/bash', ['-c', dockerBuildCommand], buildOptions);
  buildProcess.on('error', (err) => {
    toastError(err, "Docker build");
  });

  buildProcess.on('close', (code) => {
    if (code !== 0) {
      showToast(`Docker build failed for ${solution.name} (exit ${code}).`, "error");
      return;
    }

    console.log(`Docker image built for ${solution.name}.`);

    const runProcess = spawn('/bin/bash', ['-c', dockerRunCommand], buildOptions);
    runProcess.on('error', (err) => {
      toastError(err, "Docker run");
    });

    runProcess.on('close', (code) => {
      if (code !== 0) {
        showToast(`Docker run failed for ${solution.name} (exit ${code}).`, "error");
        return;
      }

      console.log(`Docker container running for ${solution.name}.`);

      const pruneProcess = spawn('/bin/bash', ['-c', dockerPruneCommand], buildOptions);
      pruneProcess.on('error', (err) => {
        toastError(err, "Docker prune");
      });

      pruneProcess.on('close', (code) => {
        if (code !== 0) {
          showToast(`Docker image prune failed (exit ${code}).`, "error");
          return;
        }

        console.log(`Dangling images removed.`);
      });
    });
  });
}

function syncRootPathInput(resolvedPath) {
  const input = document.getElementById("rootPathInput");
  if (input) {
    input.value = resolvedPath;
  }
}

function loadSolutions() {
  const configPath = path.join(__dirname, "config.json");
  const { ipcRenderer } = require("electron");

  return (async () => {
    try {
      const [userSettings, data] = await Promise.all([
        ipcRenderer.invoke("app:get-user-settings"),
        fs.promises.readFile(configPath, "utf-8"),
      ]);
      const migrated = await migrateLegacyRootPathFromLocalStorage(
        ipcRenderer,
        userSettings
      );
      let config;
      try {
        config = JSON.parse(data);
      } catch (parseErr) {
        toastError(parseErr, "Invalid config.json");
        return false;
      }
      const rootPath = getEffectiveRootPath(
        config.rootPath,
        migrated?.rootPath
      );
      effectiveRootPath = rootPath;
      syncRootPathInput(rootPath);
      loadSolutionsFromConfig({ ...config, rootPath });
      return true;
    } catch (err) {
      toastError(err, "Error loading config");
      return false;
    }
  })();
}

(function initRootPathControls() {
  const { ipcRenderer } = require("electron");
  const modalEl = document.getElementById("userSettingsModal");
  const input = document.getElementById("rootPathInput");
  const browseBtn = document.getElementById("browseRootPathBtn");
  const resetBtn = document.getElementById("resetRootPathBtn");
  const applyBtn = document.getElementById("applyRootPathBtn");
  if (!modalEl || !input || !browseBtn || !resetBtn || !applyBtn) {
    return;
  }

  function hideSettingsModal() {
    if (typeof bootstrap === "undefined") {
      return;
    }
    const inst = bootstrap.Modal.getInstance(modalEl);
    if (inst) {
      inst.hide();
    }
  }

  modalEl.addEventListener("shown.bs.modal", () => {
    syncRootPathInput(effectiveRootPath);
    syncThemePreferenceSelect();
  });

  const themeSelect = document.getElementById("themePreferenceSelect");
  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      setStoredThemePreference(themeSelect.value);
      applyDocumentTheme();
    });
  }

  applyBtn.addEventListener("click", async () => {
    const normalized = normalizeRootPathString(input.value);
    try {
      await ipcRenderer.invoke("app:set-user-settings", { rootPath: normalized });
      const ok = await loadSolutions();
      if (ok) {
        hideSettingsModal();
      }
    } catch (e) {
      toastError(e, "Could not save repos root");
    }
  });

  resetBtn.addEventListener("click", async () => {
    try {
      await ipcRenderer.invoke("app:set-user-settings", { rootPath: null });
      await loadSolutions();
    } catch (e) {
      toastError(e, "Could not reset repos root");
    }
  });

  browseBtn.addEventListener("click", async () => {
    try {
      const result = await ipcRenderer.invoke("app:open-directory-dialog");
      if (result?.canceled || !result?.path) {
        return;
      }
      const p = result.path;
      input.value = p.endsWith(path.sep) ? p : p + path.sep;
      applyBtn.click();
    } catch (e) {
      toastError(e, "Folder picker failed");
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyBtn.click();
    }
  });
})();

loadSolutions();

(function initAppVersion() {
  const { ipcRenderer } = require("electron");

  const versionLabel = document.getElementById("appVersionLabel");
  const versionSubtitle = document.getElementById("appVersionSubtitle");
  const versionFooter = document.getElementById("appVersionFooter");

  ipcRenderer.invoke("app:get-version").then((info) => {
    const tooltip = [
      info.name,
      `Version ${info.version}`,
      info.commit ? `Commit ${info.commit}` : null,
      info.builtAt ? `Built ${new Date(info.builtAt).toLocaleString()}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    if (versionLabel) {
      versionLabel.textContent = info.shortDisplay;
      versionLabel.title = tooltip;
    }
    if (versionSubtitle) {
      versionSubtitle.textContent = ` · ${info.display}`;
      versionSubtitle.title = tooltip;
    }
    if (versionFooter) {
      versionFooter.textContent = `${info.name} ${info.display}`;
      versionFooter.title = tooltip;
    }

    document.title = `${info.name} · ${info.shortDisplay}`;
  }).catch((e) => {
    toastError(e, "Could not read app version");
  });
})();

(function initAppUpdater() {
  const { ipcRenderer } = require("electron");

  const statusLabel = document.getElementById("updateStatusLabel");
  const checkBtn = document.getElementById("checkUpdatesBtn");
  const installBtn = document.getElementById("installUpdateBtn");

  if (!statusLabel || !checkBtn || !installBtn) {
    return;
  }

  function setInstallVisible(visible) {
    installBtn.classList.toggle("d-none", !visible);
  }

  function setStatusText(text) {
    statusLabel.textContent = text || "";
  }

  let installPending = false;
  let downloadedVersion = null;

  ipcRenderer.on("updater:status", (_event, payload) => {
    if (
      installPending &&
      downloadedVersion &&
      (payload.status === "checking" ||
        payload.status === "not-available" ||
        payload.status === "available" ||
        payload.status === "downloading")
    ) {
      return;
    }

    switch (payload.status) {
      case "dev":
        setStatusText("Updates run in packaged builds only");
        setInstallVisible(false);
        break;
      case "checking":
        setStatusText("Checking for updates…");
        setInstallVisible(false);
        break;
      case "available":
        setStatusText(`Update v${payload.version} found — downloading…`);
        setInstallVisible(false);
        break;
      case "downloading":
        setStatusText(`Downloading update… ${Math.round(payload.percent || 0)}%`);
        setInstallVisible(false);
        break;
      case "downloaded":
        installPending = true;
        downloadedVersion = payload.version;
        setStatusText(`Update v${payload.version} ready — restart to install`);
        setInstallVisible(true);
        break;
      case "not-available":
        setStatusText("You're on the latest version");
        setInstallVisible(false);
        break;
      case "error":
        if (installPending) {
          return;
        }
        setStatusText(payload.message || "Update check failed");
        setInstallVisible(false);
        showToast(payload.message || "Update check failed", "error");
        break;
      default:
        break;
    }
  });

  ipcRenderer.on("updater:progress", (_event, progress) => {
    if (installPending) {
      return;
    }
    setStatusText(`Downloading update… ${Math.round(progress.percent || 0)}%`);
  });

  checkBtn.addEventListener("click", async () => {
    if (installPending && downloadedVersion) {
      setStatusText(`Update v${downloadedVersion} ready — restart to install`);
      return;
    }

    checkBtn.disabled = true;
    setStatusText("Checking for updates…");
    try {
      const result = await ipcRenderer.invoke("updater:check");
      if (result?.status === "dev") {
        setStatusText("Updates run in packaged builds only");
        setInstallVisible(false);
      }
    } finally {
      checkBtn.disabled = false;
    }
  });

  installBtn.addEventListener("click", () => {
    ipcRenderer.invoke("updater:install").catch((e) => {
      toastError(e, "Could not install update");
    });
  });
})();
