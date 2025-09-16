const env = {
  BACKEND_WS: window.__env?.BACKEND_WS,
  BACKEND_API: window.__env?.BACKEND_API,
  WS_PROTOCOL: window.__env?.WS_PROTOCOL || 'ws',
  SECURE: window.__env?.SECURE || false
};


window.appConfig = env;