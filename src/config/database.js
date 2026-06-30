const { Pool } = require("pg");
require("dotenv").config();

const config = {
  connectionString: process.env.DATABASE_URL
};

// Si estamos en Render, usa SSL.
// Si estamos local, no.
if (
  process.env.DATABASE_URL &&
  process.env.DATABASE_URL.includes("render.com")
) {
  config.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(config);

module.exports = pool;