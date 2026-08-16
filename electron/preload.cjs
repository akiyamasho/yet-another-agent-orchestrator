const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("constellationDesktop", {
  platform: process.platform,
  isDesktop: true,
  selectDirectory: () => ipcRenderer.invoke("folders:select"),
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    add: (projectPath) => ipcRenderer.invoke("projects:add", projectPath),
  },
  files: {
    preview: (filePath) => ipcRenderer.invoke("files:preview", filePath),
    reveal: (filePath) => ipcRenderer.invoke("files:reveal", filePath),
  },
  codex: {
    getSnapshot: () => ipcRenderer.invoke("codex:snapshot"),
    readThread: (threadId) => ipcRenderer.invoke("codex:read-thread", threadId),
    startThread: (input) => ipcRenderer.invoke("codex:start-thread", input),
    startSubagent: (input) => ipcRenderer.invoke("codex:start-subagent", input),
    updateThread: (input) => ipcRenderer.invoke("codex:update-thread", input),
    archiveThread: (threadId) => ipcRenderer.invoke("codex:archive-thread", threadId),
    unarchiveThread: (threadId) => ipcRenderer.invoke("codex:unarchive-thread", threadId),
    deleteThread: (threadId) => ipcRenderer.invoke("codex:delete-thread", threadId),
    onNotification: (listener) => {
      const handler = (_event, message) => listener(message);
      ipcRenderer.on("codex:notification", handler);
      return () => ipcRenderer.removeListener("codex:notification", handler);
    },
    onConnection: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("codex:connection", handler);
      return () => ipcRenderer.removeListener("codex:connection", handler);
    },
  },
  claude: {
    getSnapshot: () => ipcRenderer.invoke("claude:snapshot"),
    readSession: (sessionId) => ipcRenderer.invoke("claude:read-session", sessionId),
    startSession: (input) => ipcRenderer.invoke("claude:start-session", input),
    startSubagent: (input) => ipcRenderer.invoke("claude:start-subagent", input),
    resumeSession: (input) => ipcRenderer.invoke("claude:resume-session", input),
    updateSession: (input) => ipcRenderer.invoke("claude:update-session", input),
    archiveSession: (sessionId) => ipcRenderer.invoke("claude:archive-session", sessionId),
    unarchiveSession: (sessionId) => ipcRenderer.invoke("claude:unarchive-session", sessionId),
    deleteSession: (sessionId) => ipcRenderer.invoke("claude:delete-session", sessionId),
    onNotification: (listener) => {
      const handler = (_event, message) => listener(message);
      ipcRenderer.on("claude:notification", handler);
      return () => ipcRenderer.removeListener("claude:notification", handler);
    },
    onConnection: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("claude:connection", handler);
      return () => ipcRenderer.removeListener("claude:connection", handler);
    },
  },
});
