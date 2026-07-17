const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
FUNCIONES
=================================
*/

function normalizarNumero(valor) {
  if (
    valor === null ||
    valor === undefined ||
    valor === ""
  ) {
    return null;
  }

  const numero = Number(
    String(valor)
      .trim()
      .replace(",", ".")
  );

  return Number.isFinite(numero)
    ? numero
    : null;
}

function normalizarCoordenadas(
  latitudOriginal,
  longitudOriginal
) {
  let latitud =
    normalizarNumero(latitudOriginal);

  let longitud =
    normalizarNumero(longitudOriginal);

  if (
    latitud !== null &&
    longitud !== null &&
    Math.abs(latitud) > 45 &&
    Math.abs(longitud) < 45
  ) {
    const temporal = latitud;

    latitud = longitud;
    longitud = temporal;
  }

  return {
    latitud,
    longitud
  };
}

/*
=================================
GET CLIENTES PAGINADO
=================================
*/

router.get("/", async (req, res) => {
  try {
    const buscar =
      String(
        req.query.buscar || ""
      ).trim();

    const vendedorFiltro =
      req.query.vendedor_id || null;

    const rutaFiltro =
      req.query.ruta_id || null;

    const estado =
      String(
        req.query.estado || "todos"
      ).toLowerCase();

    const limit = Math.min(
      Math.max(
        Number(req.query.limit || 50),
        1
      ),
      200
    );

    const offset = Math.max(
      Number(req.query.offset || 0),
      0
    );

    let where = `
      WHERE c.deleted_at IS NULL
    `;

    const params = [];

    /*
    ===============================
    BUSCADOR
    ===============================
    */

    if (buscar) {
      params.push(
        `%${buscar.toLowerCase()}%`
      );

      const posicion =
        params.length;

      where += `
        AND (
          LOWER(
            COALESCE(c.nombre, '')
          ) LIKE $${posicion}

          OR LOWER(
            COALESCE(
              c.codigo_cliente,
              ''
            )
          ) LIKE $${posicion}

          OR LOWER(
            COALESCE(c.direccion, '')
          ) LIKE $${posicion}

          OR LOWER(
            COALESCE(c.localidad, '')
          ) LIKE $${posicion}

          OR LOWER(
            COALESCE(r.nombre, '')
          ) LIKE $${posicion}

          OR LOWER(
            COALESCE(
              ur.nombre || ' ' ||
              ur.apellido,
              ''
            )
          ) LIKE $${posicion}

          OR LOWER(
            COALESCE(
              uc.nombre || ' ' ||
              uc.apellido,
              ''
            )
          ) LIKE $${posicion}
        )
      `;
    }

    /*
    ===============================
    FILTRO POR VENDEDOR EFECTIVO
    ===============================
    */

    if (vendedorFiltro) {
      params.push(vendedorFiltro);

      const posicion =
        params.length;

      where += `
        AND COALESCE(
          r.vendedor_id,
          c.vendedor_id
        ) = $${posicion}::uuid
      `;
    }

    /*
    ===============================
    FILTRO POR RUTA
    ===============================
    */

    if (rutaFiltro) {
      params.push(rutaFiltro);

      const posicion =
        params.length;

      where += `
        AND c.ruta_id =
          $${posicion}::uuid
      `;
    }

    /*
    ===============================
    FILTRO POR ESTADO
    ===============================
    */

    if (estado === "activos") {
      where += `
        AND c.activo = true
      `;
    }

    if (
      estado === "suspendidos" ||
      estado === "inactivos"
    ) {
      where += `
        AND c.activo = false
      `;
    }

    /*
    ===============================
    TOTAL
    ===============================
    */

    const totalResult =
      await db.query(
        `
        SELECT
          COUNT(*)::int AS total

        FROM clientes c

        LEFT JOIN rutas r
          ON r.id = c.ruta_id

        LEFT JOIN usuarios uc
          ON uc.id = c.vendedor_id

        LEFT JOIN usuarios ur
          ON ur.id = r.vendedor_id

        ${where}
        `,
        params
      );

    /*
    ===============================
    PAGINACIÓN
    ===============================
    */

    params.push(limit);

    const posicionLimit =
      params.length;

    params.push(offset);

    const posicionOffset =
      params.length;

    /*
    ===============================
    LISTADO
    ===============================
    */

    const result =
      await db.query(
        `
        SELECT
          c.id,
          c.codigo_cliente,
          c.nombre,
          c.direccion,
          c.localidad,
          c.latitud,
          c.longitud,
          c.radio_geocerca,
          c.categoria,
          c.canal_id,
          c.frecuencia_id,
          c.ruta_id,
          c.activo,
          c.created_at,
          c.updated_at,

          ca.nombre AS canal,
          fr.nombre AS frecuencia,

          r.nombre AS ruta,

          /*
          Vendedor guardado directamente
          en el cliente.
          */
          c.vendedor_id
            AS vendedor_directo_id,

          CASE
            WHEN uc.id IS NOT NULL
            THEN TRIM(
              COALESCE(uc.nombre, '') ||
              ' ' ||
              COALESCE(uc.apellido, '')
            )
            ELSE NULL
          END AS vendedor_directo,

          /*
          Vendedor titular de la ruta.
          */
          r.vendedor_id
            AS vendedor_ruta_id,

          CASE
            WHEN ur.id IS NOT NULL
            THEN TRIM(
              COALESCE(ur.nombre, '') ||
              ' ' ||
              COALESCE(ur.apellido, '')
            )
            ELSE NULL
          END AS vendedor_ruta,

          /*
          Vendedor efectivo:
          primero el de la ruta;
          si no existe, el directo.
          */
          COALESCE(
            r.vendedor_id,
            c.vendedor_id
          ) AS vendedor_id,

          CASE
            WHEN ur.id IS NOT NULL
            THEN TRIM(
              COALESCE(ur.nombre, '') ||
              ' ' ||
              COALESCE(ur.apellido, '')
            )

            WHEN uc.id IS NOT NULL
            THEN TRIM(
              COALESCE(uc.nombre, '') ||
              ' ' ||
              COALESCE(uc.apellido, '')
            )

            ELSE NULL
          END AS vendedor,

          CASE
            WHEN r.vendedor_id IS NOT NULL
            THEN 'RUTA'

            WHEN c.vendedor_id IS NOT NULL
            THEN 'CLIENTE'

            ELSE 'SIN_ASIGNAR'
          END AS origen_vendedor

        FROM clientes c

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        LEFT JOIN frecuencias fr
          ON fr.id = c.frecuencia_id

        LEFT JOIN rutas r
          ON r.id = c.ruta_id

        LEFT JOIN usuarios uc
          ON uc.id = c.vendedor_id

        LEFT JOIN usuarios ur
          ON ur.id = r.vendedor_id

        ${where}

        ORDER BY
          c.nombre ASC,
          c.codigo_cliente ASC

        LIMIT $${posicionLimit}
        OFFSET $${posicionOffset}
        `,
        params
      );

    res.json({
      total:
        totalResult.rows[0].total,

      limit,
      offset,

      clientes:
        result.rows
    });

  } catch (error) {
    console.error(
      "ERROR OBTENIENDO CLIENTES:",
      error
    );

    res.status(500).json({
      error:
        "Error al obtener clientes",

      detalle:
        error.message
    });
  }
});

/*
=================================
CLIENTES DEL VENDEDOR HOY
=================================
*/

router.get(
  "/vendedor/:vendedor_id/hoy",
  async (req, res) => {
    try {
      const { vendedor_id } =
        req.params;

      const result =
        await db.query(
          `
          SELECT DISTINCT
            c.id,
            c.codigo_cliente,
            c.nombre,
            c.direccion,
            c.localidad,
            c.latitud,
            c.longitud,
            c.radio_geocerca,
            c.categoria,

            ca.nombre AS canal,
            fr.nombre AS frecuencia,
            r.nombre AS ruta,

            COALESCE(
              r.vendedor_id,
              c.vendedor_id
            ) AS vendedor_id,

            CASE
              WHEN ur.id IS NOT NULL
              THEN TRIM(
                COALESCE(ur.nombre, '') ||
                ' ' ||
                COALESCE(ur.apellido, '')
              )

              WHEN uc.id IS NOT NULL
              THEN TRIM(
                COALESCE(uc.nombre, '') ||
                ' ' ||
                COALESCE(uc.apellido, '')
              )

              ELSE NULL
            END AS vendedor

          FROM clientes c

          LEFT JOIN canales ca
            ON ca.id = c.canal_id

          LEFT JOIN frecuencias fr
            ON fr.id = c.frecuencia_id

          LEFT JOIN rutas r
            ON r.id = c.ruta_id

          LEFT JOIN usuarios uc
            ON uc.id = c.vendedor_id

          LEFT JOIN usuarios ur
            ON ur.id = r.vendedor_id

          WHERE c.deleted_at IS NULL
            AND c.activo = true

            AND (
              (
                r.vendedor_id = $1
                AND r.activo = true
              )

              OR (
                r.vendedor_id IS NULL
                AND c.vendedor_id = $1
              )
            )

            AND (
              (
                EXTRACT(
                  ISODOW
                  FROM CURRENT_DATE
                ) = 1
                AND fr.lunes = true
              )

              OR (
                EXTRACT(
                  ISODOW
                  FROM CURRENT_DATE
                ) = 2
                AND fr.martes = true
              )

              OR (
                EXTRACT(
                  ISODOW
                  FROM CURRENT_DATE
                ) = 3
                AND fr.miercoles = true
              )

              OR (
                EXTRACT(
                  ISODOW
                  FROM CURRENT_DATE
                ) = 4
                AND fr.jueves = true
              )

              OR (
                EXTRACT(
                  ISODOW
                  FROM CURRENT_DATE
                ) = 5
                AND fr.viernes = true
              )

              OR (
                EXTRACT(
                  ISODOW
                  FROM CURRENT_DATE
                ) = 6
                AND fr.sabado = true
              )
            )

          ORDER BY
            c.nombre ASC
          `,
          [vendedor_id]
        );

      res.json(result.rows);

    } catch (error) {
      console.error(
        "ERROR CLIENTES VENDEDOR HOY:",
        error
      );

      res.status(500).json({
        error:
          "Error al obtener clientes del vendedor",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
CREAR CLIENTE
=================================
*/

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
      ruta_id,
      categoria
    } = req.body;

    if (
      !nombre ||
      !String(nombre).trim()
    ) {
      return res.status(400).json({
        error:
          "Falta dato obligatorio: nombre"
      });
    }

    const coordenadas =
      normalizarCoordenadas(
        latitud,
        longitud
      );

    const radio =
      normalizarNumero(
        radio_geocerca
      ) || 30;

    const result =
      await db.query(
        `
        INSERT INTO clientes (
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
          ruta_id,
          categoria,
          activo
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          true
        )
        RETURNING *
        `,
        [
          codigo_cliente || null,
          String(nombre).trim(),
          direccion || null,
          localidad || null,
          coordenadas.latitud,
          coordenadas.longitud,
          radio,
          canal_id || null,
          frecuencia_id || null,
          vendedor_id || null,
          ruta_id || null,
          categoria || null
        ]
      );

    res.status(201).json({
      mensaje:
        "Cliente creado correctamente",

      cliente:
        result.rows[0]
    });

  } catch (error) {
    console.error(
      "ERROR CREANDO CLIENTE:",
      error
    );

    res.status(500).json({
      error:
        "Error al crear cliente",

      detalle:
        error.message
    });
  }
});

/*
=================================
GET CLIENTE POR ID
=================================
*/

router.get("/:id", async (req, res) => {
  try {
    const { id } =
      req.params;

    const result =
      await db.query(
        `
        SELECT
          c.*,

          ca.nombre AS canal,
          fr.nombre AS frecuencia,
          r.nombre AS ruta,

          c.vendedor_id
            AS vendedor_directo_id,

          r.vendedor_id
            AS vendedor_ruta_id,

          COALESCE(
            r.vendedor_id,
            c.vendedor_id
          ) AS vendedor_efectivo_id,

          CASE
            WHEN ur.id IS NOT NULL
            THEN TRIM(
              COALESCE(ur.nombre, '') ||
              ' ' ||
              COALESCE(ur.apellido, '')
            )

            WHEN uc.id IS NOT NULL
            THEN TRIM(
              COALESCE(uc.nombre, '') ||
              ' ' ||
              COALESCE(uc.apellido, '')
            )

            ELSE NULL
          END AS vendedor

        FROM clientes c

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        LEFT JOIN frecuencias fr
          ON fr.id = c.frecuencia_id

        LEFT JOIN rutas r
          ON r.id = c.ruta_id

        LEFT JOIN usuarios uc
          ON uc.id = c.vendedor_id

        LEFT JOIN usuarios ur
          ON ur.id = r.vendedor_id

        WHERE c.id = $1
          AND c.deleted_at IS NULL
        `,
        [id]
      );

    if (
      result.rows.length === 0
    ) {
      return res.status(404).json({
        error:
          "Cliente no encontrado"
      });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error(
      "ERROR OBTENIENDO CLIENTE:",
      error
    );

    res.status(500).json({
      error:
        "Error al obtener cliente",

      detalle:
        error.message
    });
  }
});

/*
=================================
ACTUALIZAR SOLO UBICACIÓN
=================================
*/

router.put("/:id/ubicacion", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      latitud,
      longitud,
      radio_geocerca
    } = req.body;

    const coordenadas =
      normalizarCoordenadas(
        latitud,
        longitud
      );

    if (
      coordenadas.latitud === null ||
      coordenadas.longitud === null
    ) {
      return res.status(400).json({
        error: "Coordenadas inválidas"
      });
    }

    const radio =
      normalizarNumero(
        radio_geocerca
      ) || 15;

    const result =
      await db.query(
        `
        UPDATE clientes
        SET
          latitud = $1,
          longitud = $2,
          radio_geocerca = $3,
          updated_at = NOW()
        WHERE id = $4
          AND deleted_at IS NULL
        RETURNING *
        `,
        [
          coordenadas.latitud,
          coordenadas.longitud,
          radio,
          id
        ]
      );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Cliente no encontrado"
      });
    }

    res.json({
      mensaje: "Ubicación actualizada correctamente",
      cliente: result.rows[0]
    });

  } catch (error) {
    console.error(
      "ERROR ACTUALIZANDO UBICACIÓN:",
      error
    );

    res.status(500).json({
      error: "Error al actualizar ubicación",
      detalle: error.message
    });
  }
});

/*
=================================
ACTUALIZAR CLIENTE
=================================
*/

router.put("/:id", async (req, res) => {
  try {
    const { id } =
      req.params;

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
      ruta_id,
      categoria,
      activo
    } = req.body;

    if (
      !nombre ||
      !String(nombre).trim()
    ) {
      return res.status(400).json({
        error:
          "Falta dato obligatorio: nombre"
      });
    }

    const coordenadas =
      normalizarCoordenadas(
        latitud,
        longitud
      );

    const radio =
      normalizarNumero(
        radio_geocerca
      ) || 30;

    const result =
      await db.query(
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
          ruta_id = $11,
          categoria = $12,

          activo =
            COALESCE(
              $13::boolean,
              activo
            ),

          updated_at = NOW()

        WHERE id = $14
          AND deleted_at IS NULL

        RETURNING *
        `,
        [
          codigo_cliente || null,
          String(nombre).trim(),
          direccion || null,
          localidad || null,
          coordenadas.latitud,
          coordenadas.longitud,
          radio,
          canal_id || null,
          frecuencia_id || null,
          vendedor_id || null,
          ruta_id || null,
          categoria || null,

          activo === undefined
            ? null
            : activo,

          id
        ]
      );

    if (
      result.rows.length === 0
    ) {
      return res.status(404).json({
        error:
          "Cliente no encontrado"
      });
    }

    res.json({
      mensaje:
        "Cliente actualizado correctamente",

      cliente:
        result.rows[0]
    });

  } catch (error) {
    console.error(
      "ERROR ACTUALIZANDO CLIENTE:",
      error
    );

    res.status(500).json({
      error:
        "Error al actualizar cliente",

      detalle:
        error.message
    });
  }
});

/*
=================================
SUSPENDER CLIENTE
=================================
*/

router.patch(
  "/:id/suspender",
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const result =
        await db.query(
          `
          UPDATE clientes
          SET
            activo = false,
            updated_at = NOW()
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
            "Cliente no encontrado"
        });
      }

      res.json({
        mensaje:
          "Cliente suspendido correctamente",

        cliente:
          result.rows[0]
      });

    } catch (error) {
      res.status(500).json({
        error:
          "Error al suspender cliente",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
REACTIVAR CLIENTE
=================================
*/

router.patch(
  "/:id/reactivar",
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const result =
        await db.query(
          `
          UPDATE clientes
          SET
            activo = true,
            updated_at = NOW()
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
            "Cliente no encontrado"
        });
      }

      res.json({
        mensaje:
          "Cliente reactivado correctamente",

        cliente:
          result.rows[0]
      });

    } catch (error) {
      res.status(500).json({
        error:
          "Error al reactivar cliente",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
ELIMINAR CLIENTE
SOFT DELETE
=================================
*/

router.delete("/:id", async (req, res) => {
  try {
    const { id } =
      req.params;

    const result =
      await db.query(
        `
        UPDATE clientes
        SET
          deleted_at = NOW(),
          activo = false,
          updated_at = NOW()
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
          "Cliente no encontrado"
      });
    }

    res.json({
      mensaje:
        "Cliente eliminado correctamente"
    });

  } catch (error) {
    console.error(
      "ERROR ELIMINANDO CLIENTE:",
      error
    );

    res.status(500).json({
      error:
        "Error al eliminar cliente",

      detalle:
        error.message
    });
  }
});

module.exports = router;