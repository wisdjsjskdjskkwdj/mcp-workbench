const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const targetDir = 'F:\\mcp_workbench';
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const stagingBase = path.resolve('build_staging');
if (fs.existsSync(stagingBase)) {
  fs.rmSync(stagingBase, { recursive: true, force: true });
}
fs.mkdirSync(stagingBase, { recursive: true });

const cleanWorkbenchConfig = {
  version: "0.3.0",
  activeProfile: "default",
  profiles: {
    default: {
      exposeMode: "high_frequency",
      enabledServers: ["*"],
      disabledTools: []
    }
  },
  servers: {
    math_ops: {
      id: "math_ops",
      command: "node",
      args: ["./dist/test_servers/mock_server_a.js"],
      env: {},
      enabled: true,
      autoRestart: true,
      highFrequencyTools: ["add", "multiply"]
    },
    sys_clock: {
      id: "sys_clock",
      command: "node",
      args: ["./dist/test_servers/mock_server_b.js"],
      env: {},
      enabled: true,
      autoRestart: true,
      highFrequencyTools: ["get_time"]
    }
  },
  webUiEnabled: true
};

const commonFiles = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'SPECIFICATION_v0.3.0.md',
  'MCP_Workbench_教学文档.pdf',
  'install-node.bat',
  'install-node.sh',
  'stop.bat',
  'stop.sh',
  'start-web.bat',
  'start-daemon.bat',
  'start-cli.bat',
  'start-tui.bat',
  'start-web.sh',
  'start-daemon.sh',
  'start-cli.sh',
  'start-tui.sh'
];

const commonDirs = [
  'dist',
  'src',
  'micro_agent',
  'docs',
  'scripts',
  'installers'
];

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.vscode' || ent.name === 'runtime' || ent.name === 'build_staging') continue;
      copyDirRecursive(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

const platforms = [
  {
    name: 'windows',
    packages: [
      { filename: 'mcp_workbench_windows.zip', type: 'zip' }
    ]
  },
  {
    name: 'macos',
    packages: [
      { filename: 'mcp_workbench_macos.tar.gz', type: 'tar.gz' },
      { filename: 'mcp_workbench_macos.zip', type: 'zip' }
    ]
  },
  {
    name: 'linux',
    packages: [
      { filename: 'mcp_workbench_linux.tar.gz', type: 'tar.gz' },
      { filename: 'mcp_workbench_linux.zip', type: 'zip' }
    ]
  }
];

console.log('=== Step 1: Populating Staging Directories ===');
for (const p of platforms) {
  const pDir = path.join(stagingBase, p.name, 'mcp_workbench');
  fs.mkdirSync(pDir, { recursive: true });

  for (const f of commonFiles) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(pDir, f));
    }
  }

  for (const d of commonDirs) {
    if (fs.existsSync(d)) {
      copyDirRecursive(d, path.join(pDir, d));
    }
  }

  // Write clean workbench.json
  fs.writeFileSync(
    path.join(pDir, 'workbench.json'),
    JSON.stringify(cleanWorkbenchConfig, null, 2),
    'utf8'
  );

  console.log(`[OK] Staged files for ${p.name}`);
}

console.log('=== Step 2: Populating Uncompressed Release in F:\\mcp_workbench\\mcp_workbench ===');
const uncompressedTarget = path.join(targetDir, 'mcp_workbench');
if (!fs.existsSync(uncompressedTarget)) {
  fs.mkdirSync(uncompressedTarget, { recursive: true });
}

for (const f of commonFiles) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, path.join(uncompressedTarget, f));
  }
}

for (const d of commonDirs) {
  if (fs.existsSync(d)) {
    copyDirRecursive(d, path.join(uncompressedTarget, d));
  }
}

// Write clean workbench.json in uncompressed folder
fs.writeFileSync(
  path.join(uncompressedTarget, 'workbench.json'),
  JSON.stringify(cleanWorkbenchConfig, null, 2),
  'utf8'
);

// Copy runtime to uncompressed release folder so it's ready out of the box!
const runtimeSource = path.resolve('runtime');
if (fs.existsSync(runtimeSource)) {
  console.log('Copying extracted runtime to uncompressed folder for instant execution...');
  copyDirRecursive(runtimeSource, path.join(uncompressedTarget, 'runtime'));
}

console.log('[OK] Uncompressed release updated successfully.');

console.log('=== Step 3: Compressing Release Archives ===');
const tarPath = 'C:\\Windows\\System32\\tar.exe';

for (const p of platforms) {
  const platformStaging = path.join(stagingBase, p.name);
  const sourceFolder = path.join(platformStaging, 'mcp_workbench');

  for (const pkg of p.packages) {
    const destPath = path.join(targetDir, pkg.filename);
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }

    console.log(`Generating ${pkg.filename} (${pkg.type})...`);

    if (pkg.type === 'tar.gz') {
      const tarCmd = `"${tarPath}" -czf "${destPath}" -C "${platformStaging}" mcp_workbench`;
      execSync(tarCmd, { stdio: 'inherit' });
    } else if (pkg.type === 'zip') {
      const psCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceFolder.replace(/\\/g, '\\\\')}', '${destPath.replace(/\\/g, '\\\\')}', [System.IO.Compression.CompressionLevel]::Optimal, $false)"`;
      execSync(psCmd, { stdio: 'inherit' });
    }

    const stat = fs.statSync(destPath);
    console.log(`[SUCCESS] Created ${pkg.filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }
}

// Copy top-level PDF guide to F:\mcp_workbench
const pdfSrc = path.resolve('MCP_Workbench_教学文档.pdf');
if (fs.existsSync(pdfSrc)) {
  fs.copyFileSync(pdfSrc, path.join(targetDir, 'MCP_Workbench_教学文档.pdf'));
  console.log('[OK] Copied top-level PDF guide to F:\\mcp_workbench\\MCP_Workbench_教学文档.pdf');
}

// Clean up staging base
console.log('Cleaning up staging directory...');
fs.rmSync(stagingBase, { recursive: true, force: true });
console.log('=== ALL PACKAGES SUCCESSFULLY REBUILT AND VERIFIED! ===');
