// proxy.conf.js
const target = process.env.BACKEND_API || "http://localhost:8000";

module.exports = {
  "/api": {
    target: target,
    secure: false,
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    logLevel: "debug"
  }
};
