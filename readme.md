# Make it Easy => onboarding on Amwal way 😂

A tool for managing multiple solution configurations in your development environment. This tool allows you to easily manage, launch, and maintain multiple project solutions.

## Features

- 🚀 Launch multiple solutions with different IDEs
- 🔄 Get latest updates from source control
- 🐳 Docker support for containerized applications
- ⚙️ Easy configuration management
- 📤 Import/Export configuration
- 🔧 Dynamic solution addition

## Getting Started

### Prerequisites

- Node.js and npm installed
- Electron installed globally (`npm install -g electron`)
- Git installed (for source control features)
- Docker installed (for containerization features)

### Installation

1. Clone the repository:

```bash
git clone [repository-url]
cd [project-directory]
```

2. Install dependencies:

```bash
npm install
```

3. Create your configuration:

   - Copy `config.template.json` to `config.json`, or
   - Use the Configuration Manager UI to create/import your configuration

4. Start the application:

```bash
npm start
```

## Configuration

### Structure

The configuration file (`config.json`) has the following structure:

```json
{
  "rootPath": "C:\\Your\\Root\\Path",
  "solutions": [
    {
      "name": "Solution Name",
      "path": "RelativePath\\Solution.sln",
      "type": "dotnet",
      "migratorPath": "Optional\\Migrator.csproj",
      "dockerPort": 5001,
      "contextFolder": "DockerContext",
      "imageContainerName": "container-name"
    }
  ]
}
```

### Configuration Options

#### Root Path

- `rootPath`: Base directory for all solutions

#### Solution Properties

Required:

- `name`: Display name for the solution
- `path`: Relative path from root path
- `type`: Solution type ("dotnet", "nodejs", "angular", "electron")

Optional:

- `migratorPath`: Path to database migrator project
- `dockerPort`: Port for Docker container
- `contextFolder`: Docker build context folder
- `imageContainerName`: Docker container name

### Using the Configuration Manager

1. **Import Existing Configuration**

   - Click the "Configuration" tab
   - Use the "Import Configuration" section
   - Select your config.json file
   - Click "Import Configuration"

2. **Create New Configuration**

   - Set the root path in the Configuration tab
   - Add solutions using the "Add New Solution" form
   - Fill in required fields and any optional settings
   - Click "Add Solution"

3. **Manage Solutions**
   - View all solutions in the Solutions tab
   - Use action buttons to:
     - Get latest updates
     - Update database
     - Dockerize solutions
   - Select IDE preferences per solution

## Common Operations

### Adding a New Solution

1. Go to the Configuration tab
2. Fill in the "Add New Solution" form:
   - Solution Name
   - Relative Path
   - Solution Type
   - Optional settings
3. Click "Add Solution"

### Importing Configuration

1. Prepare your config.json file
2. Go to the Configuration tab
3. Click "Choose File" in the Import section
4. Select your config.json
5. Click "Import Configuration"

### Managing Solutions

- **Launch Solutions**: Select solutions and click "Run Selected Solutions"
- **Update Source**: Use "Get Latest For Selected" button
- **Database Updates**: Click "Update DB" for solutions with migrators
- **Docker**: Use "Dockerize" button for container-enabled solutions

## Best Practices

1. **Organization**

   - Keep related solutions in the same parent directory
   - Use consistent naming conventions
   - Maintain clear directory structure

2. **Configuration**

   - Back up your config.json
   - Use relative paths when possible
   - Document special requirements

3. **Docker**
   - Use consistent port numbering
   - Document port mappings
   - Use meaningful container names

## Troubleshooting

Common issues and solutions:

1. **Path Issues**

   - Ensure rootPath is correct
   - Use correct path separators
   - Verify file permissions

2. **Docker Issues**

   - Check port availability
   - Verify Docker is running
   - Check container name conflicts

3. **IDE Issues**
   - Verify IDE installations
   - Check file associations
   - Verify solution file integrity

## Publishing the app
   ### windows
   ```bash
   npx electron-packager . "make it easy" --platform=win32 --arch=x64 --icon=assets/icons/win/app.ico --overwrite
   ```
   ### MacOS 
   ```bash
   npx electron-packager . "Make it Easy" --platform=darwin --arch=arm64,x64 --icon=assets/icons/macos/app.icns --overwrite
   ```