/**
 * Heir Studio — native macOS (Electron) shell.
 * Embeds the local Express server and opens a BrowserWindow against 127.0.0.1.
 */
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  ipcMain,
  nativeTheme,
  Notification,
} from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { startServer, stopServer } from "../server/start.js";
import { createLogger } from "../server/lib/logger.js";
import { safeName } from "../server/lib/template.js";
import { registerNotificationHook } from "../server/lib/background.js";
import { migrateAppSupport } from "../server/lib/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("heir-studio-app");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Awaited<ReturnType<typeof startServer>> | null} */
let serverHandle = null;
/** Paths dropped on dock before window ready */
const pendingOpenFiles = [];

const isDev = !app.isPackaged;

function projectRoot() {
  // Dev: repo root. Packaged: Resources/app.asar or Resources/app
  return path.resolve(__dirname, "..");
}

function userDataDir() {
  return path.join(app.getPath("userData"), "data");
}

/**
 * Adopt data written under the old "Grok Studio" product name so the rename
 * does not silently start the app with an empty session list.
 */
function migrateLegacyUserData() {
  const current = path.basename(app.getPath("userData"));
  const appSupport = path.dirname(app.getPath("userData"));
  const result = migrateAppSupport(appSupport, current, log);
  if (result.migrated) {
    log.info("adopted data from previous product name", {
      from: result.from,
      to: result.to,
    });
  }
}

function resolveResources() {
  const root = projectRoot();
  return {
    root,
    publicDir: path.join(root, "public"),
    catalogPath: path.join(root, "workflows", "catalog.json"),
    data: userDataDir(),
  };
}

/**
 * If `npm run tunnel` (or `npm start`) is already serving on :3847, attach to
 * that process so desktop and phone share one session store and one live hub.
 * Starting a second server in userData would silently split the two clients.
 */
async function findSharedServer() {
  const port = Number(process.env.HEIR_STUDIO_PORT || 3847);
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return { url, token: null };
    if (res.status === 401) {
      let token = null;
      const tokenFile = path.join(projectRoot(), "data", "remote-access.json");
      try {
        token = JSON.parse(fs.readFileSync(tokenFile, "utf8")).token || null;
      } catch {
        token = null;
      }
      return { url, token };
    }
  } catch {
    // nothing listening
  }
  return null;
}

async function ensureServer() {
  if (serverHandle) return serverHandle;
  const existing = await findSharedServer();
  if (existing) {
    log.info("attaching to running studio", { url: existing.url });
    const data = path.join(projectRoot(), "data");
    serverHandle = {
      url: existing.url,
      attached: true,
      token: existing.token,
      cfg: { data, uploads: path.join(data, "uploads") },
    };
    return serverHandle;
  }
  migrateLegacyUserData();
  const res = resolveResources();
  serverHandle = await startServer({
    log,
    root: res.root,
    data: res.data,
    publicDir: res.publicDir,
    catalogPath: res.catalogPath,
    host: "127.0.0.1",
    // Ephemeral port in the app so it never fights a browser `npm start`
    port: 0,
  });
  return serverHandle;
}

function createMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Open Project…",
                accelerator: "CmdOrCtrl+O",
                click: () => void openProjectDialog(),
              },
              {
                label: "Attach Images…",
                accelerator: "CmdOrCtrl+Shift+O",
                click: () => void openImagesDialog(),
              },
              {
                label: "Reveal Data Folder",
                click: () => {
                  shell.openPath(userDataDir());
                },
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openProjectDialog(),
        },
        {
          label: "Attach Images…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => void openImagesDialog(),
        },
        {
          label: "Reveal Outputs",
          click: () => {
            const dir = path.join(userDataDir(), "outputs");
            fs.mkdirSync(dir, { recursive: true });
            shell.openPath(dir);
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(isDev ? [{ role: "toggleDevTools" }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ]
          : [{ role: "close" }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Grok Build docs",
          click: () => shell.openExternal("https://docs.x.ai/build/overview"),
        },
        {
          label: "Open Studio in Browser",
          click: () => {
            if (serverHandle) shell.openExternal(serverHandle.url);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openImagesDialog() {
  const win = mainWindow;
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: "Attach images",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Images",
        extensions: [
          "png",
          "jpg",
          "jpeg",
          "webp",
          "gif",
          "heic",
          "avif",
          "bmp",
          "tif",
          "tiff",
        ],
      },
    ],
  });
  if (result.canceled || !result.filePaths.length) return;
  await importImages(result.filePaths);
}

async function openProjectDialog() {
  const win = mainWindow;
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: "Open project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const dir = result.filePaths[0];
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("studio:project-opened", dir);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return dir;
}

async function importImages(filePaths) {
  const handle = await ensureServer();
  const uploads = handle.cfg.uploads;
  fs.mkdirSync(uploads, { recursive: true });
  const imported = [];
  for (const src of filePaths) {
    if (!fs.existsSync(src)) continue;
    const ext = path.extname(src) || ".png";
    const base = path.basename(src, ext);
    const dest = path.join(
      uploads,
      `${Date.now()}-${safeName(base)}${ext.toLowerCase()}`,
    );
    fs.copyFileSync(src, dest);
    imported.push({
      name: path.basename(dest),
      path: dest,
      url: `/files/uploads/${path.basename(dest)}`,
      size: fs.statSync(dest).size,
      kind: "image",
    });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("studio:images-imported", imported);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return imported;
}

async function createWindow(url, { token } = {}) {
  const iconPath = path.join(__dirname, "icon.png");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "Heir Studio",
    backgroundColor: "#0a0b0e",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (process.platform === "darwin") app.dock?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  // Keep navigation on the local server only
  mainWindow.webContents.on("will-navigate", (event, navUrl) => {
    if (!navUrl.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (token) {
    // Tunnel mode requires a token even on loopback. EventSource cannot set
    // Authorization, so the same token is also a cookie the renderer sends.
    await mainWindow.webContents.session.cookies.set({
      url,
      name: "heir_stream",
      value: token,
      httpOnly: true,
      sameSite: "lax",
    });
  }

  mainWindow.loadURL(url);
}

function showNativeNotification({ title, body }) {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: title || "Heir Studio",
    body: body || "",
    silent: false,
  });
  n.show();
  return true;
}

function registerIpc() {
  ipcMain.handle("studio:open-images", async () => openImagesDialog());
  ipcMain.handle("studio:open-project", async () => openProjectDialog());
  ipcMain.handle("studio:reveal-path", async (_e, targetPath) => {
    if (typeof targetPath !== "string" || !targetPath) return false;
    if (!fs.existsSync(targetPath)) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });
  ipcMain.handle("studio:reveal-outputs", async () => {
    const dir = path.join(userDataDir(), "outputs");
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });
  ipcMain.handle("studio:get-info", async () => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    dataDir: userDataDir(),
    url: serverHandle?.url ?? null,
    platform: process.platform,
  }));
  ipcMain.handle("studio:import-paths", async (_e, paths) => {
    if (!Array.isArray(paths)) return [];
    return importImages(paths.filter((p) => typeof p === "string"));
  });
  ipcMain.handle("studio:notify", async (_e, payload) => {
    const title = payload?.title || "Heir Studio";
    const body = payload?.body || "";
    showNativeNotification({ title, body });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("studio:notification", { title, body });
    }
    return true;
  });
}

function wireBackgroundNotifications() {
  registerNotificationHook((event) => {
    if (
      event.type === "background.completed" ||
      event.type === "background.failed"
    ) {
      showNativeNotification({
        title: event.title || "Background agent",
        body: event.body || event.status || "",
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("studio:notification", event);
      }
    }
  });
}

// macOS: files dropped on dock icon before ready
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    void importImages([filePath]);
  } else {
    pendingOpenFiles.push(filePath);
  }
});

app.on("second-instance", (_event, argv) => {
  const files = argv.filter((a) => /\.(png|jpe?g|webp|gif|heic|avif|bmp|tiff?)$/i.test(a));
  if (files.length) void importImages(files);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    nativeTheme.themeSource = "dark";
    registerIpc();
    wireBackgroundNotifications();
    createMenu();

    try {
      const handle = await ensureServer();
      await createWindow(handle.url, { token: handle.token });
      if (pendingOpenFiles.length) {
        await importImages(pendingOpenFiles.splice(0));
      }
      // CLI args when launched with image paths
      const launchFiles = process.argv
        .slice(isDev ? 2 : 1)
        .filter((a) => fs.existsSync(a) && /\.(png|jpe?g|webp|gif|heic|avif|bmp|tiff?)$/i.test(a));
      if (launchFiles.length) await importImages(launchFiles);
    } catch (err) {
      log.error("startup failed", { message: err.message, stack: err.stack });
      dialog.showErrorBox(
        "Heir Studio failed to start",
        `${err.message}\n\nIs another instance stuck? Check that grok is installed (~/.grok/bin/grok).`,
      );
      app.quit();
    }

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const handle = await ensureServer();
        await createWindow(handle.url, { token: handle.token });
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Do not kill a tunnel/npm-start we attached to.
  if (serverHandle && !serverHandle.attached) {
    void stopServer(serverHandle);
  }
  serverHandle = null;
});
