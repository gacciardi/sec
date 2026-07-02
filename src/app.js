require("dotenv").config();
const alertasRoutes = require("./routes/alertas.routes");
const gpsLogsRoutes = require("./routes/gpslogs.routes");
const visitasRoutes = require("./routes/visitas.routes");
const clientesRoutes = require("./routes/clientes.routes");
const frecuenciasRoutes = require("./routes/frecuencias.routes");
const clientesImportRoutes = require("./routes/clientes-import.routes");
const express = require("express");
const cors = require("cors");
const db = require("./config/database");
const usuariosRoutes = require("./routes/usuarios.routes");
const canalesRoutes = require("./routes/canales.routes");
const coberturaRoutes = require("./routes/cobertura.routes");
const pendientesRoutes = require("./routes/pendientes.routes");
const mapaRoutes = require("./routes/mapa.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const configuracionRoutes = require("./routes/configuracion.routes");

const app = express();

app.use(cors());

app.use(express.json());

console.log("APP.JS CARGADO");

db.query("SELECT NOW()")
  .then((result) => {
    console.log("Conectado a PostgreSQL");
    console.log(result.rows[0]);
  })
  .catch((err) => {
    console.error("Error PostgreSQL:", err.message);
  });

app.get("/", (req, res) => {
  res.send("SEC FUNCIONANDO");
});

app.get("/usuarios-test", (req, res) => {
  res.send("USUARIOS TEST OK");
});

app.use("/usuarios", usuariosRoutes);

app.get("/canales-directo", (req, res) => {
  res.send("CANALES DIRECTO OK");
});

app.get("/canales", async (req, res) => {
  const result = await db.query(`
    SELECT id, nombre, permanencia_minima, activo
    FROM canales
    WHERE deleted_at IS NULL
    ORDER BY nombre
  `);

  res.json(result.rows);
});

app.use("/frecuencias", frecuenciasRoutes);

app.use("/clientes", clientesRoutes);

app.use("/visitas", visitasRoutes);

app.use("/gps-logs", gpsLogsRoutes);

app.use("/alertas", alertasRoutes);

app.use("/clientes/importar-excel", clientesImportRoutes);

app.use("/cobertura", coberturaRoutes);

app.use("/pendientes", pendientesRoutes);

app.use("/mapa", mapaRoutes);

app.use("/dashboard", dashboardRoutes);

app.use("/configuracion", configuracionRoutes);

const PORT = process.env.PORT || 7890;

app.listen(PORT, () => {
  console.log("Servidor SEC iniciado en puerto " + PORT);

  setInterval(async () => {
  try {
    await fetch("https://sec-backend-gg4j.onrender.com/alertas/control-login", {
      method: "POST"
    });
  } catch (error) {
    console.log("Control login pendiente:", error.message);
  }
}, 5 * 60 * 1000);

});
