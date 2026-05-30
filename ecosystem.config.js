module.exports = {
  apps: [
    {
      name: "wa-radius",
      script: "src/index.js",
      cwd: "/home/daniswara/radius-server/wa-radius",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "/home/daniswara/radius-server/wa-radius/logs/error.log",
      out_file: "/home/daniswara/radius-server/wa-radius/logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
};