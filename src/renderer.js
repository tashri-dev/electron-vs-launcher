const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { exec, execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20000;
const GIT_FETCH_TIMEOUT_MS = 120000;
const GIT_FETCH_CONCURRENCY = 4;
const GIT_CHECKOUT_CONCURRENCY = 4;
const SWITCHABLE_BRANCHES = ["master_dev", "master_sit", "master_uat", "master_oci"];
const SWITCHABLE_BRANCH_SET = new Set(SWITCHABLE_BRANCHES);
const CUSTOM_BRANCH_OPTION_VALUE = "__custom__";

/** @type {Map<string, Set<HTMLSelectElement>>} */
const branchSelectsByRepo = new Map();
/** @type {Map<string, { branches: string[], current: string }>} */
const branchStateByRepo = new Map();
let globalBranchRefreshTimer = null;

/** Migrated once to user-settings.json (userData); safe to remove later */
const LEGACY_ROOT_PATH_STORAGE_KEY = "electron-vs-launcher-root-path";

let effectiveRootPath = "";
let activeConfigPath = null;

const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config.json");
let lastLoadedRawConfig = null;
let lastLoadedConfigFilePath = null;

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

  const customOption = document.createElement("option");
  customOption.value = CUSTOM_BRANCH_OPTION_VALUE;
  customOption.textContent = "Custom branch…";
  select.appendChild(customOption);

  select._currentBranch = current || "";
  select.disabled = false;
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
  td.classList.add("app-branch-cell");

  const select = document.createElement("select");
  select.classList.add("form-select", "form-select-sm", "app-branch-select");
  select.setAttribute("aria-label", `Git branch for ${solution.name}`);
  select.title = "Switch git branch";
  setBranchSelectPlaceholder(select, "Loading…");
  td.appendChild(select);

  const customWrap = document.createElement("div");
  customWrap.classList.add("app-custom-branch", "d-none", "d-flex", "align-items-center", "gap-1");

  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.classList.add("form-control", "form-control-sm", "app-custom-branch-input");
  customInput.placeholder = "Branch name";
  customInput.setAttribute("aria-label", `Custom git branch for ${solution.name}`);
  customWrap.appendChild(customInput);

  const createLabel = document.createElement("label");
  createLabel.classList.add("form-check", "form-check-inline", "small", "text-nowrap", "mb-0", "app-custom-branch-create-label");
  const createCheckbox = document.createElement("input");
  createCheckbox.type = "checkbox";
  createCheckbox.classList.add("form-check-input");
  createCheckbox.title = "Create the branch if it doesn't already exist (git checkout -b)";
  createLabel.appendChild(createCheckbox);
  createLabel.appendChild(document.createTextNode(" Create if not exist"));
  customWrap.appendChild(createLabel);

  td.appendChild(customWrap);

  const cancelCustomBranch = () => {
    customInput.value = "";
    createCheckbox.checked = false;
    customWrap.classList.add("d-none");
    select.classList.remove("d-none");
    select.value = select._currentBranch || "";
  };

  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      cancelCustomBranch();
    }
  });
  customInput.addEventListener("blur", () => {
    if (!customInput.value.trim()) {
      cancelCustomBranch();
    }
  });

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
    if (select.value === CUSTOM_BRANCH_OPTION_VALUE) {
      select.classList.add("d-none");
      customWrap.classList.remove("d-none");
      customInput.focus();
      return;
    }
    onBranchSelectChange(select, target.repoDir, solution.name);
  });
  customInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    onCustomBranchSubmit(select, customInput, createCheckbox, customWrap, target.repoDir, solution.name);
  });
  loadBranchesIntoSelect(select, target.repoDir);
  return td;
}

async function onCustomBranchSubmit(select, input, createCheckbox, customWrap, repoDir, name) {
  const branch = input.value.trim();
  if (!branch) {
    return;
  }
  if (!repoDir) {
    showToast(`Could not switch branch (${name}): repository not found`, "error");
    return;
  }

  const prev = select._currentBranch || "";
  const createIfMissing = createCheckbox.checked;
  input.disabled = true;
  createCheckbox.disabled = true;
  try {
    await gitExec(repoDir, ["checkout", ...(createIfMissing ? ["-b"] : []), branch]);
    showToast(`Switched ${name} to ${branch}`, "success");
    input.value = "";
    createCheckbox.checked = false;
    customWrap.classList.add("d-none");
    select.classList.remove("d-none");
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
  } finally {
    input.disabled = false;
    createCheckbox.disabled = false;
  }
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

document
  .getElementById("openInCursorBtn")
  .addEventListener("click", openSelectedReposInCursor);


document.getElementById("clearBtn").addEventListener("click", clearSelections);
document
  .getElementById("selectAllBtn")
  .addEventListener("click", selectAllCheckboxes);
document.getElementById('get-latest-selected').addEventListener('click', getLatestFromSelected);
document.getElementById("fetchAllBtn").addEventListener("click", fetchAllRepos);
document
  .getElementById("globalBranchSelect")
  .addEventListener("change", onGlobalBranchChange);

const riderPath = `${os.homedir()}/Applications/Rider.app/Contents/MacOS/rider`;

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

function openInVSCode(folderPath) {
  if (!fs.existsSync(folderPath)) {
    showToast(`Path does not exist:\n${folderPath}`, "error");
    return;
  }
  const child = spawn("open", ["-a", "Visual Studio Code", folderPath], {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (err) => {
    toastError(err, "Could not open in VS Code");
  });
  child.unref();
}

// —— Status monitoring (port-based) ——

const STATUS_POLL_INTERVAL_MS = 30000;
let statusRows = [];
let statusPollTimer = null;

function parsePortFromUrl(urlStr) {
  try {
    const u = new URL(String(urlStr).trim());
    if (u.port) {
      return parseInt(u.port, 10);
    }
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function firstPortFromUrls(urlsStr) {
  if (!urlsStr) {
    return null;
  }
  const parts = String(urlsStr)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const port = parsePortFromUrl(part);
    if (port) {
      return port;
    }
  }
  return null;
}

function readLaunchSettingsPort(startupProjectPath, aspnetCoreEnvironment) {
  try {
    const projectDir = fs.statSync(startupProjectPath).isDirectory()
      ? startupProjectPath
      : path.dirname(startupProjectPath);
    const launchSettingsPath = path.join(projectDir, "Properties", "launchSettings.json");
    if (!fs.existsSync(launchSettingsPath)) {
      return null;
    }
    const json = JSON.parse(fs.readFileSync(launchSettingsPath, "utf-8"));
    const profiles = Object.values(json.profiles || {});

    let chosen = null;
    if (aspnetCoreEnvironment) {
      chosen = profiles.find(
        (p) => p?.environmentVariables?.ASPNETCORE_ENVIRONMENT === aspnetCoreEnvironment
      );
    }
    if (!chosen) {
      chosen = profiles.find((p) => p?.commandName === "Project" && p?.applicationUrl);
    }
    if (!chosen) {
      chosen = profiles.find((p) => p?.applicationUrl);
    }
    if (!chosen?.applicationUrl) {
      return null;
    }
    return firstPortFromUrls(chosen.applicationUrl);
  } catch {
    return null;
  }
}

// Resolves the port to monitor for a solution's running status, per the
// launchProfiles/aspnetCoreUrls the app actually launches with.
function resolveMonitoredPort(solution, rootPath) {
  const cat = solution.category || "dotnet";

  if (solution.aspnetCoreUrls) {
    const port = firstPortFromUrls(solution.aspnetCoreUrls);
    if (port) {
      return port;
    }
  }

  if (cat === "dotnet") {
    const startupProjectPath = path.isAbsolute(solution.startupProject)
      ? solution.startupProject
      : path.join(rootPath, solution.startupProject);
    return readLaunchSettingsPort(startupProjectPath, solution.aspnetCoreEnvironment);
  }

  if (solution.port != null && solution.port !== "") {
    const n = Number(solution.port);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

function applyLampState(lampEl, state, port) {
  lampEl.classList.remove("status-lamp--green", "status-lamp--red", "status-lamp--grey");
  lampEl.classList.add(`status-lamp--${state}`);
  const label = lampEl.querySelector(".status-lamp__label");
  if (state === "green") {
    label.textContent = "Running";
    lampEl.title = `Listening on port ${port}`;
  } else if (state === "red") {
    label.textContent = "Stopped";
    lampEl.title = `Not listening on port ${port}`;
  } else {
    label.textContent = "Unknown";
    lampEl.title = "No port configured for this solution";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollStatusRow(row) {
  const running = row.port ? await probePort(row.port) : false;
  const state = !row.port ? "grey" : running ? "green" : "red";
  row.status = state;
  applyLampState(row.lampEl, state, row.port);
  row.killBtn.classList.toggle("d-none", state !== "green");
  row.refreshColumnVisibility?.();
}

async function pollAllStatuses() {
  await Promise.all(statusRows.map((row) => pollStatusRow(row)));
  updateKillSelectedButtonState();
}

function startStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
  }
  pollAllStatuses();
  statusPollTimer = setInterval(pollAllStatuses, STATUS_POLL_INTERVAL_MS);
}

function updateKillSelectedButtonState() {
  const btn = document.getElementById("killSelectedBtn");
  if (!btn) {
    return;
  }
  const hasRunningSelected = statusRows.some(
    (row) => row.checkbox.checked && row.status === "green"
  );
  btn.disabled = !hasRunningSelected;
}

// —— Kill by port ——

function findPidsForPort(port) {
  return new Promise((resolve) => {
    if (!port) {
      resolve([]);
      return;
    }
    exec(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const pids = String(stdout)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      resolve(Array.from(new Set(pids)));
    });
  });
}

async function killPort(port, name) {
  const pids = await findPidsForPort(port);
  if (pids.length === 0) {
    showToast(`No process found listening on port ${port} for ${name}.`, "info");
    return;
  }

  pids.forEach((pid) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  });

  showToast(`Stopping ${name} (port ${port})…`, "info");

  await delay(1500);

  pids.forEach((pid) => {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  });

  // Actively re-check rather than waiting for the next auto-poll cycle,
  // since some processes take longer than one fixed delay to release the port.
  for (let attempt = 0; attempt < 8; attempt++) {
    await pollAllStatuses();
    const stillRunning = statusRows.some((r) => r.port === port && r.status === "green");
    if (!stillRunning) {
      break;
    }
    await delay(500);
  }
}

function confirmAction({ title, message, items = [], confirmLabel = "Confirm" }, onConfirm) {
  const modalEl = document.getElementById("confirmActionModal");
  if (!modalEl || typeof bootstrap === "undefined") {
    if (window.confirm([message, ...items].filter(Boolean).join("\n"))) {
      onConfirm();
    }
    return;
  }

  document.getElementById("confirmActionModalLabel").textContent = title || "Confirm";
  document.getElementById("confirmActionMessage").textContent = message || "";

  const list = document.getElementById("confirmActionList");
  list.replaceChildren();
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });

  const oldBtn = document.getElementById("confirmActionConfirmBtn");
  oldBtn.textContent = confirmLabel;
  const freshBtn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(freshBtn);

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  freshBtn.addEventListener(
    "click",
    () => {
      modal.hide();
      onConfirm();
    },
    { once: true }
  );

  modal.show();
}

function runInIdeForSolution(solution, solutionPath, startupProjectPath) {
  const cat = solution.category || "dotnet";
  if (cat === "node" || cat === "angular" || cat === "angualr") {
    openInVSCode(startupProjectPath || solutionPath);
    return;
  }
  isRiderRunning((running) => {
    const launch = () => launchSolution(solutionPath);
    if (!running) {
      preWarmRider();
      setTimeout(launch, 3000);
    } else {
      launch();
    }
  });
}

document.getElementById("killSelectedBtn")?.addEventListener("click", () => {
  const targets = statusRows.filter((row) => row.checkbox.checked && row.status === "green");
  if (targets.length === 0) {
    return;
  }
  confirmAction(
    {
      title: "Kill selected services",
      message: `Stop ${targets.length} running solution${targets.length > 1 ? "s" : ""}?`,
      items: targets.map((t) => `${t.name} — port ${t.port}`),
      confirmLabel: "Kill selected",
    },
    () => {
      targets.forEach((t) => killPort(t.port, t.name));
    }
  );
});

// Launch selected checkboxes
function launchSelectedSolutions() {
  const dotnetCheckboxes = [];
  document
    .querySelectorAll('input[type="checkbox"]:checked')
    .forEach((checkbox) => {
      const cat = checkbox._category || "dotnet";
      if (cat === "node" || cat === "angular" || cat === "angualr") {
        openInVSCode(checkbox.value);
      } else {
        dotnetCheckboxes.push(checkbox);
      }
    });

  if (dotnetCheckboxes.length === 0) return;

  isRiderRunning((running) => {
    const launch = () => dotnetCheckboxes.forEach((cb) => launchSolution(cb.value));
    if (!running) {
      preWarmRider();
      setTimeout(launch, 3000);
    } else {
      launch();
    }
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

function launchSelectedSolutionsSafely() {
  launchSelectedSolutions();
}


function collectUniqueRepoTargets({ selectedOnly = false } = {}) {
  const seen = new Map();
  const selector = selectedOnly
    ? '#solutionsContainer input[type="checkbox"]:checked'
    : '#solutionsContainer input[type="checkbox"]';
  document.querySelectorAll(selector).forEach((checkbox) => {
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

function runDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function findCursorCommand() {
  const cursorApp = "/Applications/Cursor.app";
  const binaries = [
    "/usr/local/bin/cursor",
    "/opt/homebrew/bin/cursor",
    path.join(cursorApp, "Contents", "Resources", "app", "bin", "cursor"),
  ];
  const bin = binaries.find((candidate) => fs.existsSync(candidate));
  if (bin) {
    return { command: bin, args: [] };
  }
  if (process.platform === "darwin" && fs.existsSync(cursorApp)) {
    return { command: "open", args: ["-a", "Cursor"] };
  }
  return null;
}

async function writeCursorWorkspaceFile(targets) {
  const workspace = {
    folders: targets.map(({ repoDir, name }) => ({
      name,
      path: repoDir,
    })),
  };
  const payload = JSON.stringify(workspace, null, 2) + "\n";
  const candidates = [
    effectiveRootPath
      ? path.join(effectiveRootPath, "amwal-pay-launcher.code-workspace")
      : "",
    path.join(os.tmpdir(), "amwal-pay-launcher.code-workspace"),
  ].filter(Boolean);

  let lastError = null;
  for (const filePath of candidates) {
    try {
      await fs.promises.writeFile(filePath, payload, "utf8");
      return filePath;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Could not write Cursor workspace file");
}

async function openSelectedReposInCursor() {
  const targets = collectUniqueRepoTargets({ selectedOnly: true });
  if (targets.length === 0) {
    showToast("Select at least one solution to open in Cursor", "info");
    return;
  }

  const cursor = findCursorCommand();
  if (!cursor) {
    showToast("Cursor is not installed", "error");
    return;
  }

  try {
    const workspacePath = await writeCursorWorkspaceFile(targets);
    await runDetached(cursor.command, [...cursor.args, workspacePath]);
    showToast(
      `Opened ${targets.length} ${targets.length === 1 ? "repo" : "repos"} in Cursor`,
      "success"
    );
  } catch (err) {
    toastError(err, "Could not open Cursor workspace");
  }
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
  updateKillSelectedButtonState();
}
function selectAllCheckboxes() {
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((checkbox) => {
    checkbox.checked = true;
  });
  updateKillSelectedButtonState();
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

    if (cat === "node" || cat === "angular" || cat === "angualr") {
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

    const noLaunchProfile = aspnetCoreEnvironment ? "--no-launch-profile " : "";
    const command = `${envExports}"${dotnetPath}" run ${noLaunchProfile}--project "${startupProjectPath}"; echo; echo 'Press any key to exit...'; read -n 1`;    const osaScript = [
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

  const runInIdeHeader = document.createElement("th");
  runInIdeHeader.textContent = "Run In IDE";
  runInIdeHeader.classList.add("text-nowrap");

  const dockerizeHeader = document.createElement("th");
  dockerizeHeader.textContent = "Dockerize";
  dockerizeHeader.classList.add("text-nowrap");

  const statusHeader = document.createElement("th");
  statusHeader.textContent = "Status";
  statusHeader.classList.add("text-nowrap");

  const killHeader = document.createElement("th");
  killHeader.textContent = "Kill";
  killHeader.classList.add("text-nowrap");

  headerRow.appendChild(nameHeader);
  headerRow.appendChild(branchHeader);
  headerRow.appendChild(getLatestHeader);
  headerRow.appendChild(updateDbHeader);
  headerRow.appendChild(runInConsoleHeader);
  headerRow.appendChild(runInIdeHeader);
  headerRow.appendChild(dockerizeHeader);
  headerRow.appendChild(statusHeader);
  headerRow.appendChild(killHeader);
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");

  const tableStatusCells = [statusHeader];
  const tableKillCells = [killHeader];
  const tableRunningFlags = [];

  function refreshColumnVisibility() {
    const hasRunning = tableRunningFlags.some((flag) => flag.status === "green");
    tableStatusCells.forEach((cell) => cell.classList.toggle("d-none", !hasRunning));
    tableKillCells.forEach((cell) => cell.classList.toggle("d-none", !hasRunning));
  }

  // Hidden by default until the first status poll determines actual state.
  refreshColumnVisibility();

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

    checkbox.addEventListener("change", updateKillSelectedButtonState);

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

    // Run In IDE button column
    const runInIdeTd = document.createElement("td");
    runInIdeTd.classList.add("text-nowrap");
    if (solution?.solutionPath != null || solution?.startupProject != null) {
      const runInIdeEl = document.createElement("button");
      runInIdeEl.classList.add("btn", "btn-info", "btn-sm");
      runInIdeEl.innerHTML = '<i class="fa fa-code me-1"></i> Run In IDE';
      runInIdeEl.onclick = () =>
        runInIdeForSolution(
          solution,
          path.join(rootPath, solution.solutionPath),
          path.join(rootPath, solution.startupProject)
        );
      runInIdeTd.appendChild(runInIdeEl);
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

    // Status lamp column
    const statusTd = document.createElement("td");
    statusTd.classList.add("text-nowrap");
    const lampEl = document.createElement("span");
    lampEl.classList.add("status-lamp", "status-lamp--grey");
    const dotEl = document.createElement("span");
    dotEl.classList.add("status-lamp__dot");
    dotEl.setAttribute("aria-hidden", "true");
    const lampLabel = document.createElement("span");
    lampLabel.classList.add("status-lamp__label");
    lampLabel.textContent = "Unknown";
    lampEl.appendChild(dotEl);
    lampEl.appendChild(lampLabel);
    statusTd.appendChild(lampEl);
    tableStatusCells.push(statusTd);

    // Kill button column
    const killTd = document.createElement("td");
    killTd.classList.add("text-nowrap");
    const killBtn = document.createElement("button");
    killBtn.classList.add("btn", "btn-danger", "btn-sm", "d-none");
    killBtn.innerHTML = '<i class="fa fa-stop-circle me-1"></i> Kill';
    killBtn.onclick = () => {
      const row = statusRows.find((r) => r.checkbox === checkbox);
      if (!row) {
        return;
      }
      confirmAction(
        {
          title: "Kill running service",
          message: `Stop "${solution.name}"?`,
          items: [`Port ${row.port}`],
          confirmLabel: "Kill",
        },
        () => killPort(row.port, solution.name)
      );
    };
    killTd.appendChild(killBtn);
    tableKillCells.push(killTd);

    row.appendChild(checkboxTd);
    row.appendChild(createBranchCell(solution, rootPath));
    row.appendChild(getLatestTd);
    row.appendChild(updateDbTd);
    row.appendChild(runInConsoleTd);
    row.appendChild(runInIdeTd);
    row.appendChild(dockerizeTd);
    row.appendChild(statusTd);
    row.appendChild(killTd);

    const statusRow = {
      name: solution.name,
      port: resolveMonitoredPort(solution, rootPath),
      lampEl,
      killBtn,
      checkbox,
      status: "grey",
      refreshColumnVisibility,
    };
    tableRunningFlags.push(statusRow);
    statusRows.push(statusRow);

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

  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
  statusRows = [];

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
      updateKillSelectedButtonState();
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
  startStatusPolling();
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

function syncConfigPathInput(configPath) {
  const input = document.getElementById("configPathInput");
  if (input) {
    input.value = configPath ?? "";
  }
}

function loadSolutions() {
  const { ipcRenderer } = require("electron");

  return (async () => {
    try {
      const userSettings = await ipcRenderer.invoke("app:get-user-settings");
      const migrated = await migrateLegacyRootPathFromLocalStorage(
        ipcRenderer,
        userSettings
      );

      const configPath = migrated?.configPath ? migrated.configPath : DEFAULT_CONFIG_PATH;

      let data;
      try {
        data = await fs.promises.readFile(configPath, "utf-8");
      } catch (err) {
        toastError(err, `Error reading config: ${configPath}`);
        return false;
      }

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
      activeConfigPath = migrated?.configPath ?? null;
      effectiveRootPath = rootPath;
      lastLoadedRawConfig = config;
      lastLoadedConfigFilePath = configPath;
      syncRootPathInput(rootPath);
      syncConfigPathInput(activeConfigPath);
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
    syncConfigPathInput(activeConfigPath);
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

  const browseConfigBtn = document.getElementById("browseConfigPathBtn");
  const resetConfigBtn = document.getElementById("resetConfigPathBtn");

  if (browseConfigBtn && resetConfigBtn) {
    browseConfigBtn.addEventListener("click", async () => {
      try {
        const result = await ipcRenderer.invoke("app:open-file-dialog");
        if (result?.canceled || !result?.path) {
          return;
        }
        await ipcRenderer.invoke("app:set-user-settings", { configPath: result.path });
        await loadSolutions();
      } catch (e) {
        toastError(e, "Config file picker failed");
      }
    });

    resetConfigBtn.addEventListener("click", async () => {
      try {
        await ipcRenderer.invoke("app:set-user-settings", { configPath: null });
        await loadSolutions();
      } catch (e) {
        toastError(e, "Could not reset config path");
      }
    });
  }
})();

(function initManageSolutionsControls() {
  const modalEl = document.getElementById("manageSolutionsModal");
  const listBody = document.getElementById("manageSolutionsList");
  const jsonView = document.getElementById("manageSolutionsJsonView");
  const configPathLabel = document.getElementById("manageSolutionsConfigPath");
  const sectionDatalist = document.getElementById("manageSolutionsSectionList");
  const addForm = document.getElementById("addSolutionForm");
  const saveBtn = document.getElementById("saveManageSolutionsBtn");
  const statusEl = document.getElementById("manageSolutionsStatus");
  const formLabel = document.getElementById("addSolutionFormLabel");
  const submitBtn = document.getElementById("addSolutionSubmitBtn");
  const cancelEditBtn = document.getElementById("cancelEditSolutionBtn");
  if (!modalEl || !listBody || !addForm || !saveBtn) {
    return;
  }

  const SOLUTION_FIELDS = [
    "solutionPath",
    "startupProject",
    "migratorPath",
    "contextFolder",
    "dockerPort",
    "imageContainerName",
    "port",
    "npmScript",
    "aspnetCoreUrls",
    "aspnetCoreEnvironment",
  ];

  let workingConfig = null;
  let editingRef = null; // { sectionIndex, solutionIndex }

  function updateFormModeUI() {
    if (editingRef) {
      formLabel.textContent = "Edit solution";
      submitBtn.innerHTML = '<i class="fa fa-save me-1" aria-hidden="true"></i> Update solution';
      cancelEditBtn.classList.remove("d-none");
    } else {
      formLabel.textContent = "Add a solution";
      submitBtn.innerHTML = '<i class="fa fa-plus me-1" aria-hidden="true"></i> Add solution';
      cancelEditBtn.classList.add("d-none");
    }
  }

  function exitEditMode() {
    editingRef = null;
    addForm.reset();
    updateFormModeUI();
  }

  function getSections(config) {
    if (Array.isArray(config.sections)) {
      return config.sections;
    }
    if (Array.isArray(config.solutions)) {
      config.sections = [{ title: "Solutions", solutions: config.solutions }];
      delete config.solutions;
    } else {
      config.sections = [];
    }
    return config.sections;
  }

  function render() {
    const sections = getSections(workingConfig);

    listBody.replaceChildren();
    sections.forEach((section, sectionIndex) => {
      (section.solutions || []).forEach((solution, solutionIndex) => {
        const tr = document.createElement("tr");

        const sectionTd = document.createElement("td");
        sectionTd.textContent = section.title || "";

        const nameTd = document.createElement("td");
        nameTd.textContent = solution.name || "";

        const categoryTd = document.createElement("td");
        categoryTd.textContent = solution.category || "dotnet";

        const actionTd = document.createElement("td");
        actionTd.classList.add("text-nowrap");

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.classList.add("btn", "btn-sm", "btn-outline-secondary", "me-1");
        editBtn.innerHTML = '<i class="fa fa-pencil" aria-hidden="true"></i>';
        editBtn.title = "Edit";
        editBtn.onclick = () => {
          editingRef = { sectionIndex, solutionIndex };
          addForm.reset();
          addForm.section.value = section.title || "";
          addForm.name.value = solution.name || "";
          addForm.category.value = solution.category || "dotnet";
          SOLUTION_FIELDS.forEach((field) => {
            if (addForm[field]) {
              addForm[field].value = solution[field] || "";
            }
          });
          updateFormModeUI();
          addForm.scrollIntoView({ behavior: "smooth", block: "center" });
        };

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.classList.add("btn", "btn-sm", "btn-outline-danger");
        removeBtn.innerHTML = '<i class="fa fa-trash" aria-hidden="true"></i>';
        removeBtn.title = "Remove";
        removeBtn.onclick = () => {
          section.solutions.splice(solutionIndex, 1);
          if (section.solutions.length === 0) {
            sections.splice(sectionIndex, 1);
          }
          if (editingRef) {
            exitEditMode();
          }
          render();
        };
        actionTd.appendChild(editBtn);
        actionTd.appendChild(removeBtn);

        tr.appendChild(sectionTd);
        tr.appendChild(nameTd);
        tr.appendChild(categoryTd);
        tr.appendChild(actionTd);
        listBody.appendChild(tr);
      });
    });

    sectionDatalist.replaceChildren();
    sections.forEach((section) => {
      const opt = document.createElement("option");
      opt.value = section.title || "";
      sectionDatalist.appendChild(opt);
    });

    jsonView.textContent = JSON.stringify(workingConfig, null, 2);
    statusEl.textContent = "";
  }

  modalEl.addEventListener("show.bs.modal", () => {
    workingConfig = JSON.parse(
      JSON.stringify(lastLoadedRawConfig || { rootPath: "", sections: [] })
    );
    const targetPath = lastLoadedConfigFilePath || DEFAULT_CONFIG_PATH;
    configPathLabel.textContent = `Editing: ${targetPath}`;
    editingRef = null;
    addForm.reset();
    updateFormModeUI();
    render();
  });

  cancelEditBtn?.addEventListener("click", () => {
    exitEditMode();
  });

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const formData = new FormData(addForm);
    const sectionTitle = String(formData.get("section") || "").trim();
    const name = String(formData.get("name") || "").trim();
    if (!sectionTitle || !name) {
      statusEl.textContent = "Section and name are required.";
      return;
    }

    const solution = {
      name,
      category: String(formData.get("category") || "dotnet"),
    };
    SOLUTION_FIELDS.forEach((field) => {
      const value = String(formData.get(field) || "").trim();
      if (value) {
        solution[field] = value;
      }
    });

    const sections = getSections(workingConfig);

    if (editingRef) {
      const { sectionIndex, solutionIndex } = editingRef;
      const oldSection = sections[sectionIndex];
      const editingSameSection = oldSection && oldSection.title === sectionTitle;
      editingRef = null;

      if (editingSameSection) {
        // Replace in place so the solution keeps its original position.
        oldSection.solutions.splice(solutionIndex, 1, solution);
      } else {
        if (oldSection?.solutions) {
          oldSection.solutions.splice(solutionIndex, 1);
          if (oldSection.solutions.length === 0) {
            sections.splice(sectionIndex, 1);
          }
        }
        let section = sections.find((s) => s.title === sectionTitle);
        if (!section) {
          section = { title: sectionTitle, solutions: [] };
          sections.push(section);
        }
        section.solutions = section.solutions || [];
        section.solutions.push(solution);
      }
    } else {
      let section = sections.find((s) => s.title === sectionTitle);
      if (!section) {
        section = { title: sectionTitle, solutions: [] };
        sections.push(section);
      }
      section.solutions = section.solutions || [];
      section.solutions.push(solution);
    }

    addForm.reset();
    updateFormModeUI();
    render();
  });

  saveBtn.addEventListener("click", async () => {
    const { ipcRenderer } = require("electron");
    let targetPath = lastLoadedConfigFilePath || DEFAULT_CONFIG_PATH;
    try {
      // The bundled config.json lives inside the packaged app (app.asar in
      // production), which is read-only. If no custom override is active,
      // redirect the save to a writable file in app data and remember it
      // as the active config path going forward.
      if (targetPath === DEFAULT_CONFIG_PATH) {
        const userDataPath = await ipcRenderer.invoke("app:get-user-data-path");
        targetPath = path.join(userDataPath, "config.json");
        await ipcRenderer.invoke("app:set-user-settings", { configPath: targetPath });
      }

      try {
        await fs.promises.copyFile(targetPath, `${targetPath}.backup`);
      } catch {
        /* no existing file to back up */
      }
      await fs.promises.writeFile(
        targetPath,
        JSON.stringify(workingConfig, null, 2),
        "utf-8"
      );
      statusEl.textContent = "Saved.";
      await loadSolutions();
    } catch (e) {
      toastError(e, "Could not save configuration");
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
