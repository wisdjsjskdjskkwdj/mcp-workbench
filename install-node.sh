#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "==================================================="
echo "  🛠️  MCP Workbench - Node.js 运行环境检测与安装向导"
echo "==================================================="
echo ""

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  echo "[OK] 系统已安装 Node.js: $NODE_VER"
  echo "运行环境就绪，您可以直接执行 ./start-web.sh 或 ./start-cli.sh 启动工作台。"
  exit 0
fi

echo "[INFO] 未检测到系统 Node.js 运行环境，正在尝试自动安装..."

OS="$(uname -s)"
case "${OS}" in
  Darwin*)
    if command -v brew >/dev/null 2>&1; then
      echo "[INFO] 检测到 Homebrew，正在执行 brew install node..."
      brew install node
    else
      echo "[NOTICE] 未检测到 Homebrew。建议使用以下命令安装 nvm / Node.js:"
      echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
      echo "或访问官方网站下载 PKG 安装包: https://nodejs.org/"
      exit 1
    fi
    ;;
  Linux*)
    if command -v apt-get >/dev/null 2>&1; then
      echo "[INFO] 检测到 Debian/Ubuntu 系统，正在通过 NodeSource 安装 Node.js LTS..."
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf >/dev/null 2>&1; then
      echo "[INFO] 检测到 Fedora/RHEL 系统，正在安装 Node.js..."
      sudo dnf install -y nodejs
    elif command -v yum >/dev/null 2>&1; then
      echo "[INFO] 检测到 CentOS/RHEL 系统，正在安装 Node.js..."
      sudo yum install -y nodejs
    elif command -v pacman >/dev/null 2>&1; then
      echo "[INFO] 检测到 Arch Linux 系统，正在安装 Node.js..."
      sudo pacman -S --noconfirm nodejs npm
    else
      echo "[NOTICE] 请使用系统的包管理器安装 Node.js (>= 18):"
      echo "  Debian/Ubuntu: sudo apt-get install -y nodejs"
      echo "  Arch Linux:    sudo pacman -S nodejs"
      echo "或访问官方网站下载: https://nodejs.org/"
      exit 1
    fi
    ;;
  *)
    echo "[ERROR] 未识别的操作系统: ${OS}，请访问 https://nodejs.org/ 手动安装。"
    exit 1
    ;;
esac

if command -v node >/dev/null 2>&1; then
  echo ""
  echo "🎉 [SUCCESS] Node.js 安装成功: $(node -v)"
  echo "现在可以直接执行 ./start-web.sh 或 ./start-cli.sh 启动工作台！"
else
  echo "[ERROR] 安装未能成功，请手动安装 Node.js 后重试。"
  exit 1
fi
