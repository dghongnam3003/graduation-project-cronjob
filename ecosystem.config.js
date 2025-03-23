module.exports = {
  apps: [
    {
      name: "staging___fetch",
      script: "dist/fetch.js",
      watch: false,
      cron_restart: "0 */6 * * *",
      ignore_watch: ["storage"],
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      max_memory_restart: "1000M",
      node_args: [
        "--max-heap-size=1024"
      ]
    },
  ],
};
