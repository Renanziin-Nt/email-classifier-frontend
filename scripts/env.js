const env = {
  BACKEND_WS: window.__env?.BACKEND_WS || 'localhost:8000',
  BACKEND_API: window.__env?.BACKEND_API || 'http://localhost:8000',
  WS_PROTOCOL: window.__env?.WS_PROTOCOL || 'ws',
  SECURE: window.__env?.SECURE || false
};


window.appConfig = env;