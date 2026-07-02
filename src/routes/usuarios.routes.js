const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        id, nombre, apellido, email, rol, legajo, activo,
        hora_alerta_login,
        alerta_login_activa
      FROM usuarios
      WHERE deleted_at IS NULL
      ORDER BY rol, apellido, nombre
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener usuarios",
      detalle: error.message
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const {
      nombre,
      apellido,
      email,
      rol,
      legajo,
      hora_alerta_login,
      alerta_login_activa
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO usuarios (
        nombre,
        apellido,
        email,
        rol,
        legajo,
        activo,
        hora_alerta_login,
        alerta_login_activa
      )
      VALUES ($1,$2,$3,$4,$5,true,$6,$7)
      RETURNING *
      `,
      [
        nombre,
        apellido,
        email,
        rol || "VENDEDOR",
        legajo || null,
        hora_alerta_login || "08:45",
        alerta_login_activa === undefined ? true : alerta_login_activa
      ]
    );

    res.status(201).json({
      mensaje: "Usuario creado correctamente",
      usuario: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al crear usuario",
      detalle: error.message
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      nombre,
      apellido,
      email,
      rol,
      legajo,
      activo,
      hora_alerta_login,
      alerta_login_activa
    } = req.body;

    const result = await db.query(
      `
      UPDATE usuarios
      SET
        nombre = $1,
        apellido = $2,
        email = $3,
        rol = $4,
        legajo = $5,
        activo = COALESCE($6::boolean, activo),
        hora_alerta_login = COALESCE($7::time, hora_alerta_login),
        alerta_login_activa = COALESCE($8::boolean, alerta_login_activa),
        updated_at = NOW()
      WHERE id = $9 AND deleted_at IS NULL
      RETURNING *
      `,
      [
        nombre,
        apellido,
        email,
        rol,
        legajo || null,
        activo === undefined ? null : activo,
        hora_alerta_login || null,
        alerta_login_activa === undefined ? null : alerta_login_activa,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      mensaje: "Usuario actualizado correctamente",
      usuario: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al actualizar usuario",
      detalle: error.message
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `
      UPDATE usuarios
      SET deleted_at = NOW(), activo = false
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      mensaje: "Usuario eliminado correctamente"
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al eliminar usuario",
      detalle: error.message
    });
  }
});

module.exports = router;