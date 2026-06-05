import { app, BrowserWindow, Menu, shell } from "electron";
import { getWebUrl, windowOptions } from "./config";

let mainWindow: BrowserWindow | null = null;

function fallbackHtml(webUrl: string): string {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>KumikoRoom 启动失败</title>
      </head>
      <body>
        <main style="font-family: Microsoft YaHei, Segoe UI, sans-serif; padding: 32px;">
          <h1>KumikoRoom 还没有连上陪伴房间</h1>
          <p>请先启动 web 服务，然后重新打开桌面端。</p>
          <p>当前连接地址：<code>${webUrl}</code></p>
        </main>
      </body>
    </html>
  `;
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "KumikoRoom",
        submenu: [
          { label: "刷新", accelerator: "CmdOrCtrl+R", role: "reload" },
          { label: "开发者工具", accelerator: "F12", role: "toggleDevTools" },
          { type: "separator" },
          { label: "退出", accelerator: "CmdOrCtrl+Q", role: "quit" }
        ]
      }
    ])
  );
}

async function createWindow(): Promise<void> {
  const webUrl = getWebUrl(process.env);
  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  try {
    await mainWindow.loadURL(webUrl);
  } catch {
    await mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(fallbackHtml(webUrl))}`);
  }
}

app.whenReady().then(async () => {
  installMenu();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
