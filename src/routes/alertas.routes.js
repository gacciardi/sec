const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
GET ALERTAS DEL DÍA
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        a.*,
        u.nombre || ' ' || u.apellido AS vendedor
      FROM alertas a
      LEFT JOIN usuarios u ON u.id = a.vendedor_id
      WHERE DATE(a.fecha_hora) = CURRENT_DATE
      ORDER BY a.fecha_hora DESC
    `);

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener alertas",
      detalle: error.message
    });
  }
});

/*
=================================
POST ALERTA
=================================
*/

router.post("/", async (req, res) => {
  try {
    const {
      vendedor_id,
      cliente_id,
      visita_id,
      tipo,
      prioridad,
      descripcion,
      latitud,
      longitud
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO alertas (
        vendedor_id,
        cliente_id,
        visita_id,
        tipo,
        prioridad,
        descripcion,
        latitud,
        longitud,
        fecha_hora
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      RETURNING *
      `,
      [
        vendedor_id || null,
        cliente_id || null,
        visita_id || null,
        tipo || "INFO",
        prioridad || "BAJA",
        descripcion || "",
        latitud || null,
        longitud || null
      ]
    );

    res.status(201).json({
      mensaje: "Alerta creada",
      alerta: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al crear alerta",
      detalle: error.message
    });
  }
});

/*
=================================
CONTROL VENDEDORES NO LOGUEADOS
=================================
*/

router.post("/control-login", async (req, res) => {
  try {
    const vendedores = await db.query(`
      SELECT id, nombre, apellido, legajo, hora_alerta_login
      FROM usuarios
      WHERE rol = 'VENDEDOR'
        AND activo = true
        AND alerta_login_activa = true
        AND hora_alerta_login <= CURRENT_TIME
    `);

    const alertasCreadas = [];

    for (const v of vendedores.rows) {
      const loginHoy = await db.query(
        `
        SELECT id
        FROM alertas
        WHERE vendedor_id = $1
          AND tipo = 'LOGIN'
          AND DATE(fecha_hora) = CURRENT_DATE
        LIMIT 1
        `,
        [v.id]
      );

      if (loginHoy.rows.length > 0) continue;

      const alertaExistente = await db.query(
        `
        SELECT id
        FROM alertas
        WHERE vendedor_id = $1
          AND tipo = 'NO_LOGIN'
          AND DATE(fecha_hora) = CURRENT_DATE
        LIMIT 1
        `,
        [v.id]
      );

      if (alertaExistente.rows.length > 0) continue;

      const nueva = await db.query(
        `
        INSERT INTO alertas (
          vendedor_id,
          tipo,
          prioridad,
          descripcion,
          fecha_hora
        )
        VALUES ($1,'NO_LOGIN','ALTA',$2,NOW())
        RETURNING *
        `,
        [
          v.id,
          `${v.nombre} ${v.apellido} no inició sesión a la hora programada (${v.hora_alerta_login})`
        ]
      );

      alertasCreadas.push(nueva.rows[0]);
    }

    res.json({
      mensaje: "Control de login ejecutado",
      alertas_creadas: alertasCreadas.length,
      alertas: alertasCreadas
    });

  } catch (error) {
    res.status(500).json({
      error: "Error en control de login",
      detalle: error.message
    });
  }
});

module.exports = router;