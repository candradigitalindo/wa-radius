module.exports = {
  apps: [
    {
      name: "wa-radius",
      script: "src/index.js",
      cwd: "/www/wwwroot/wa-radius.binjaidc.com",
      interpreter: "/home/candra/.nvm/versions/node/v20.20.2/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "/www/wwwroot/wa-radius.binjaidc.com/logs/error.log",
      out_file: "/www/wwwroot/wa-radius.binjaidc.com/logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
};
