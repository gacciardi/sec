const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
FUNCIONES
=================================
*/

function numeroValido(valor) {
  const numero = Number(valor);

  return Number.isFinite(numero)
    ? numero
    : null;
}

/*
=================================
ESTADOS DE LOS VENDEDORES

VERDE:
último GPS menor a 5 minutos.

AMARILLO:
entre 5 y 15 minutos.

ROJO:
entre 15 y 60 minutos.

OCULTO:
más de 60 minutos o sesión cerrada.
=================================
*/

router.get(
  "/estados-vendedores",
  async (req, res) => {
    try {
      const result = await db.query(
        `
        WITH ultimo_gps AS (
          SELECT DISTINCT ON (
            g.vendedor_id
          )
            g.vendedor_id,
            g.latitud,
            g.longitud,
            g.precision_metros,
            g.velocidad,
            g.fecha_hora

          FROM gps_logs g

          ORDER BY
            g.vendedor_id,
            g.fecha_hora DESC
        ),

        ultima_sesion AS (
          SELECT DISTINCT ON (
            s.vendedor_id
          )
            s.id AS sesion_id,
            s.vendedor_id,
            s.inicio_sesion,
            s.primer_gps,
            s.primer_movimiento,
            s.primer_cliente,
            s.ultimo_gps,
            s.cierre_sesion,
            s.estado

          FROM sesiones_vendedores s

          ORDER BY
            s.vendedor_id,
            s.inicio_sesion DESC
        )

        SELECT
          u.id AS vendedor_id,

          TRIM(
            COALESCE(u.nombre, '') ||
            ' ' ||
            COALESCE(u.apellido, '')
          ) AS vendedor,

          u.nombre,
          u.apellido,
          u.legajo,
          u.activo,

          s.sesion_id,
          s.inicio_sesion,
          s.primer_gps,
          s.primer_movimiento,
          s.primer_cliente,
          s.ultimo_gps,
          s.cierre_sesion,
          s.estado AS estado_sesion,

          g.latitud,
          g.longitud,
          g.precision_metros,
          g.velocidad,
          g.fecha_hora AS fecha_ultimo_gps,

          CASE
            WHEN g.fecha_hora IS NULL
            THEN NULL

            ELSE FLOOR(
              EXTRACT(
                EPOCH FROM (
                  NOW() - g.fecha_hora
                )
              ) / 60
            )::INTEGER
          END AS minutos_sin_gps,

          CASE
            WHEN s.estado IS DISTINCT FROM
              'ACTIVA'
            THEN 'DESCONECTADO'

            WHEN g.fecha_hora IS NULL
            THEN 'SIN_GPS'

            WHEN NOW() - g.fecha_hora
              < INTERVAL '5 minutes'
            THEN 'VERDE'

            WHEN NOW() - g.fecha_hora
              < INTERVAL '15 minutes'
            THEN 'AMARILLO'

            WHEN NOW() - g.fecha_hora
              < INTERVAL '60 minutes'
            THEN 'ROJO'

            ELSE 'OCULTO'
          END AS estado_mapa,

          CASE
            WHEN s.estado = 'ACTIVA'
              AND g.fecha_hora IS NOT NULL
              AND NOW() - g.fecha_hora
                < INTERVAL '60 minutes'
            THEN true

            ELSE false
          END AS mostrar_en_mapa

        FROM usuarios u

        LEFT JOIN ultima_sesion s
          ON s.vendedor_id = u.id

        LEFT JOIN ultimo_gps g
          ON g.vendedor_id = u.id

        WHERE u.deleted_at IS NULL
          AND u.activo = true
          AND UPPER(TRIM(u.rol)) =
            'VENDEDOR'

        ORDER BY
          u.apellido,
          u.nombre
        `
      );

      const vendedores =
        result.rows;

      const resumen = {
        verdes:
          vendedores.filter(
            vendedor =>
              vendedor.estado_mapa ===
              "VERDE"
          ).length,

        amarillos:
          vendedores.filter(
            vendedor =>
              vendedor.estado_mapa ===
              "AMARILLO"
          ).length,

        rojos:
          vendedores.filter(
            vendedor =>
              vendedor.estado_mapa ===
              "ROJO"
          ).length,

        desconectados:
          vendedores.filter(
            vendedor =>
              !vendedor.mostrar_en_mapa
          ).length
      };

      res.json({
        resumen,
        vendedores
      });

    } catch (error) {
      console.error(
        "ERROR ESTADOS VENDEDORES:",
        error
      );

      res.status(500).json({
        error:
          "Error al obtener estados de vendedores",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
INICIAR SESIÓN DEL VENDEDOR
=================================
*/

router.post(
  "/:id/iniciar-sesion",
  async (req, res) => {
    const conexion =
      await db.connect();

    try {
      const { id } =
        req.params;

      const {
        latitud,
        longitud
      } = req.body;

      const latitudInicio =
        numeroValido(latitud);

      const longitudInicio =
        numeroValido(longitud);

      await conexion.query("BEGIN");

      const usuarioResult =
        await conexion.query(
          `
          SELECT
            id,
            nombre,
            apellido,
            rol,
            activo
          FROM usuarios
          WHERE id = $1
            AND deleted_at IS NULL
          FOR UPDATE
          `,
          [id]
        );

      if (
        usuarioResult.rows.length === 0
      ) {
        await conexion.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          error:
            "Vendedor no encontrado"
        });
      }

      const usuario =
        usuarioResult.rows[0];

      if (
        usuario.activo !== true ||
        String(usuario.rol || "")
          .toUpperCase() !==
          "VENDEDOR"
      ) {
        await conexion.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "El usuario no es un vendedor activo"
        });
      }

      /*
      Cerramos cualquier sesión anterior
      que haya quedado abierta.
      */

      await conexion.query(
        `
        UPDATE sesiones_vendedores
        SET
          estado = 'CERRADA',
          cierre_sesion =
            COALESCE(
              cierre_sesion,
              NOW()
            ),
          updated_at = NOW()
        WHERE vendedor_id = $1
          AND estado = 'ACTIVA'
        `,
        [id]
      );

      const sesionResult =
        await conexion.query(
          `
          INSERT INTO sesiones_vendedores (
            vendedor_id,
            fecha,
            inicio_sesion,
            estado,
            latitud_inicio,
            longitud_inicio,
            ultima_latitud,
            ultima_longitud
          )
          VALUES (
            $1,
            CURRENT_DATE,
            NOW(),
            'ACTIVA',
            $2,
            $3,
            $2,
            $3
          )
          RETURNING *
          `,
          [
            id,
            latitudInicio,
            longitudInicio
          ]
        );

      await conexion.query("COMMIT");

      res.status(201).json({
        mensaje:
          "Sesión iniciada correctamente",

        sesion:
          sesionResult.rows[0]
      });

    } catch (error) {
      await conexion.query(
        "ROLLBACK"
      );

      console.error(
        "ERROR INICIANDO SESIÓN:",
        error
      );

      res.status(500).json({
        error:
          "Error al iniciar sesión",

        detalle:
          error.message
      });

    } finally {
      conexion.release();
    }
  }
);

/*
=================================
CERRAR SESIÓN DEL VENDEDOR
=================================
*/

router.post(
  "/:id/cerrar-sesion",
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        latitud,
        longitud
      } = req.body;

      const latitudFin =
        numeroValido(latitud);

      const longitudFin =
        numeroValido(longitud);

      const result =
        await db.query(
          `
          UPDATE sesiones_vendedores
          SET
            estado = 'CERRADA',
            cierre_sesion = NOW(),

            latitud_fin =
              COALESCE(
                $2,
                ultima_latitud,
                latitud_inicio
              ),

            longitud_fin =
              COALESCE(
                $3,
                ultima_longitud,
                longitud_inicio
              ),

            updated_at = NOW()

          WHERE id = (
            SELECT id
            FROM sesiones_vendedores
            WHERE vendedor_id = $1
              AND estado = 'ACTIVA'
            ORDER BY inicio_sesion DESC
            LIMIT 1
          )

          RETURNING *
          `,
          [
            id,
            latitudFin,
            longitudFin
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.json({
          mensaje:
            "No había una sesión activa"
        });
      }

      res.json({
        mensaje:
          "Sesión cerrada correctamente",

        sesion:
          result.rows[0]
      });

    } catch (error) {
      console.error(
        "ERROR CERRANDO SESIÓN:",
        error
      );

      res.status(500).json({
        error:
          "Error al cerrar sesión",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
LISTADO DE USUARIOS
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result =
      await db.query(
        `
        SELECT
          id,
          nombre,
          apellido,
          email,
          rol,
          legajo,
          activo,
          hora_alerta_login,
          alerta_login_activa
        FROM usuarios
        WHERE deleted_at IS NULL
        ORDER BY
          rol,
          apellido,
          nombre
        `
      );

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error:
        "Error al obtener usuarios",

      detalle:
        error.message
    });
  }
});

/*
=================================
CREAR USUARIO
=================================
*/

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

    const result =
      await db.query(
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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          true,
          $6,
          $7
        )
        RETURNING *
        `,
        [
          nombre,
          apellido,
          email,
          rol || "VENDEDOR",
          legajo || null,

          hora_alerta_login ||
            "08:45",

          alerta_login_activa ===
            undefined
            ? true
            : alerta_login_activa
        ]
      );

    res.status(201).json({
      mensaje:
        "Usuario creado correctamente",

      usuario:
        result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error:
        "Error al crear usuario",

      detalle:
        error.message
    });
  }
});

/*
=================================
ACTUALIZAR USUARIO
=================================
*/

router.put("/:id", async (req, res) => {
  try {
    const { id } =
      req.params;

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

    const result =
      await db.query(
        `
        UPDATE usuarios
        SET
          nombre = $1,
          apellido = $2,
          email = $3,
          rol = $4,
          legajo = $5,

          activo =
            COALESCE(
              $6::boolean,
              activo
            ),

          hora_alerta_login =
            COALESCE(
              $7::time,
              hora_alerta_login
            ),

          alerta_login_activa =
            COALESCE(
              $8::boolean,
              alerta_login_activa
            ),

          updated_at = NOW()

        WHERE id = $9
          AND deleted_at IS NULL

        RETURNING *
        `,
        [
          nombre,
          apellido,
          email,
          rol,
          legajo || null,

          activo === undefined
            ? null
            : activo,

          hora_alerta_login ||
            null,

          alerta_login_activa ===
            undefined
            ? null
            : alerta_login_activa,

          id
        ]
      );

    if (
      result.rows.length === 0
    ) {
      return res.status(404).json({
        error:
          "Usuario no encontrado"
      });
    }

    res.json({
      mensaje:
        "Usuario actualizado correctamente",

      usuario:
        result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error:
        "Error al actualizar usuario",

      detalle:
        error.message
    });
  }
});

/*
=================================
ELIMINAR USUARIO
=================================
*/

router.delete("/:id", async (req, res) => {
  try {
    const { id } =
      req.params;

    await db.query(
      `
      UPDATE sesiones_vendedores
      SET
        estado = 'CERRADA',
        cierre_sesion =
          COALESCE(
            cierre_sesion,
            NOW()
          ),
        updated_at = NOW()
      WHERE vendedor_id = $1
        AND estado = 'ACTIVA'
      `,
      [id]
    );

    const result =
      await db.query(
        `
        UPDATE usuarios
        SET
          deleted_at = NOW(),
          activo = false
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING *
        `,
        [id]
      );

    if (
      result.rows.length === 0
    ) {
      return res.status(404).json({
        error:
          "Usuario no encontrado"
      });
    }

    res.json({
      mensaje:
        "Usuario eliminado correctamente"
    });

  } catch (error) {
    res.status(500).json({
      error:
        "Error al eliminar usuario",

      detalle:
        error.message
    });
  }
});

module.exports = router;