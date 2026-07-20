import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopPreloadApi } from './preload-api';

contextBridge.exposeInMainWorld('piCode', createDesktopPreloadApi(ipcRenderer));
