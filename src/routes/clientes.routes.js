const express = require("express");
const db = require("../config/database");

const router = express.Router();

function normalizarNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;

  const numero = Number(String(valor).trim().replace(",", "."));
  return isNaN(numero) ? null : numero;
}

function normalizarCoordenadas(lat, lng) {
  let latitud = normalizarNumero(lat);
  let longitud = normalizarNumero(lng);

  if (
    latitud !== null &&
    longitud !== null &&
    Math.abs(latitud) > 45 &&
    Math.abs(longitud) < 45
  ) {
    const temp = latitud;
    latitud = longitud;
    longitud = temp;
  }

  return { latitud, longitud };
}

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        c.id, c.codigo_cliente, c.nombre, c.direccion, c.localidad,
        c.latitud, c.longitud, c.radio_geocerca,
        c.categoria, c.canal_id, c.frecuencia_id,
        c.vendedor_id, c.activo,
        ca.nombre AS canal,
        fr.nombre AS frecuencia,
        u.nombre || ' ' || u.apellido AS vendedor
      FROM clientes c
      LEFT JOIN canales ca ON ca.id = c.canal_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      LEFT JOIN usuarios u ON u.id = c.vendedor_id
      WHERE c.deleted_at IS NULL
      ORDER BY c.nombre
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener clientes",
      detalle: error.message
    });
  }
});

router.get("/vendedor/:vendedor_id/hoy", async (req, res) => {
  try {
    const { vendedor_id } = req.params;

    const result = await db.query(`
      SELECT
        c.id, c.codigo_cliente, c.nombre, c.direccion, c.localidad,
        c.latitud, c.longitud,
        ca.nombre AS canal,
        fr.nombre AS frecuencia
      FROM clientes c
      LEFT JOIN canales ca ON ca.id = c.canal_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      WHERE c.deleted_at IS NULL
        AND c.activo = true
        AND c.vendedor_id = $1
        AND (
          (EXTRACT(ISODOW FROM CURRENT_DATE)=1 AND fr.lunes=true)
          OR (EXTRACT(ISODOW FROM CURRENT_DATE)=2 AND fr.martes=true)
          OR (EXTRACT(ISODOW FROM CURRENT_DATE)=3 AND fr.miercoles=true)
          OR (EXTRACT(ISODOW FROM CURRENT_DATE)=4 AND fr.jueves=true)
          OR (EXTRACT(ISODOW FROM CURRENT_DATE)=5 AND fr.viernes=true)
          OR (EXTRACT(ISODOW FROM CURRENT_DATE)=6 AND fr.sabado=true)
        )
      ORDER BY c.nombre
    `, [vendedor_id]);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener clientes del vendedor",
      detalle: error.message
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const {
      codigo_cliente,
      nombre,
      direccion,
      localidad,
      latitud,
      longitud,
      radio_geocerca,
      canal_id,
      frecuencia_id,
      vendedor_id,
      categoria
    } = req.body;

    if (!nombre) {
      return res.status(400).json({
        error: "Falta dato obligatorio: nombre"
      });
    }

    const coords = normalizarCoordenadas(latitud, longitud);

    const result = await db.query(
      `
      INSERT INTO clientes (
        codigo_cliente, nombre, direccion, localidad,
        latitud, longitud, radio_geocerca,
        canal_id, frecuencia_id, vendedor_id, categoria
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        codigo_cliente || null,
        nombre,
        direccion || null,
        localidad || null,
        coords.latitud,
        coords.longitud,
        normalizarNumero(radio_geocerca) || 15,
        canal_id || null,
        frecuencia_id || null,
        vendedor_id || null,
        categoria || null
      ]
    );

    res.status(201).json({
      mensaje: "Cliente creado correctamente",
      cliente: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al crear cliente",
      detalle: error.message
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `
      SELECT *
      FROM clientes
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener cliente",
      detalle: error.message
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      codigo_cliente,
      nombre,
      direccion,
      localidad,
      latitud,
      longitud,
      radio_geocerca,
      canal_id,
      frecuencia_id,
      vendedor_id,
      categoria,
      activo
    } = req.body;

    const coords = normalizarCoordenadas(latitud, longitud);

    const result = await db.query(
      `
      UPDATE clientes
      SET
        codigo_cliente = $1,
        nombre = $2,
        direccion = $3,
        localidad = $4,
        latitud = $5,
        longitud = $6,
        radio_geocerca = $7,
        canal_id = $8,
        frecuencia_id = $9,
        vendedor_id = $10,
        categoria = $11,
        activo = COALESCE($12::boolean, activo),
        updated_at = NOW()
      WHERE id = $13 AND deleted_at IS NULL
      RETURNING *
      `,
      [
        codigo_cliente || null,
        nombre,
        direccion || null,
        localidad || null,
        coords.latitud,
        coords.longitud,
        normalizarNumero(radio_geocerca) || 15,
        canal_id || null,
        frecuencia_id || null,
        vendedor_id || null,
        categoria || null,
        activo === undefined ? null : activo,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json({
      mensaje: "Cliente actualizado correctamente",
      cliente: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al actualizar cliente",
      detalle: error.message
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `
      UPDATE clientes
      SET deleted_at = NOW(), activo = false
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json({
      mensaje: "Cliente eliminado correctamente"
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al eliminar cliente",
      detalle: error.message
    });
  }
});

module.exports = router;