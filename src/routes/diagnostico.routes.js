Biblioteca
/
diagnostico.routes.txt


const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
  GET /diagnostico/cliente/:codigo?fecha=AAAA-MM-DD
  Busca el cliente por codigo_cliente y muestra:
  - ruta
  - vendedor directo
  - vendedor de la ruta
  - vendedor efectivo
  - frecuencia
  - posibles inconsistencias
  - visitas de la fecha consultada
*/
router.get("/cliente/:codigo", async (req, res) => {
  try {
    const codigo = String(req.params.codigo || "").trim();
    const fecha = String(req.query.fecha || "").trim();

    if (!codigo) {
      return res.status(400).json({
        error: "Debe indicar un código de cliente"
      });
    }

    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({
        error: "La fecha debe tener formato AAAA-MM-DD"
      });
    }

    const resultado = await db.query(
      `
      WITH parametros AS (
        SELECT COALESCE($2::date, CURRENT_DATE) AS fecha_consulta
      )
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.localidad,
        c.activo,
        c.deleted_at,
        c.ruta_id,

        r.nombre AS ruta,
        r.activo AS ruta_activa,

        c.vendedor_id AS vendedor_directo_id,
        TRIM(
          COALESCE(vd.nombre, '') || ' ' || COALESCE(vd.apellido, '')
        ) AS vendedor_directo,

        r.vendedor_id AS vendedor_ruta_id,
        TRIM(
          COALESCE(vr.nombre, '') || ' ' || COALESCE(vr.apellido, '')
        ) AS vendedor_ruta,

        COALESCE(r.vendedor_id, c.vendedor_id) AS vendedor_efectivo_id,

        CASE
          WHEN r.vendedor_id IS NOT NULL THEN
            TRIM(COALESCE(vr.nombre, '') || ' ' || COALESCE(vr.apellido, ''))
          WHEN c.vendedor_id IS NOT NULL THEN
            TRIM(COALESCE(vd.nombre, '') || ' ' || COALESCE(vd.apellido, ''))
          ELSE NULL
        END AS vendedor_efectivo,

        CASE
          WHEN r.vendedor_id IS NOT NULL THEN 'RUTA'
          WHEN c.vendedor_id IS NOT NULL THEN 'CLIENTE'
          ELSE 'SIN ASIGNAR'
        END AS origen_vendedor,

        f.id AS frecuencia_id,
        f.nombre AS frecuencia,

        p.fecha_consulta,

        CASE
          WHEN EXTRACT(ISODOW FROM p.fecha_consulta) = 1 THEN COALESCE(f.lunes, false)
          WHEN EXTRACT(ISODOW FROM p.fecha_consulta) = 2 THEN COALESCE(f.martes, false)
          WHEN EXTRACT(ISODOW FROM p.fecha_consulta) = 3 THEN COALESCE(f.miercoles, false)
          WHEN EXTRACT(ISODOW FROM p.fecha_consulta) = 4 THEN COALESCE(f.jueves, false)
          WHEN EXTRACT(ISODOW FROM p.fecha_consulta) = 5 THEN COALESCE(f.viernes, false)
          WHEN EXTRACT(ISODOW FROM p.fecha_consulta) = 6 THEN COALESCE(f.sabado, false)
          ELSE false
        END AS corresponde_fecha,

        CASE
          WHEN c.ruta_id IS NOT NULL
           AND c.vendedor_id IS NOT NULL
           AND r.vendedor_id IS NOT NULL
           AND c.vendedor_id <> r.vendedor_id
          THEN true
          ELSE false
        END AS conflicto_vendedores,

        CASE
          WHEN c.ruta_id IS NOT NULL
           AND c.vendedor_id IS NOT NULL
          THEN true
          ELSE false
        END AS vendedor_directo_sobrante

      FROM clientes c
      LEFT JOIN rutas r
        ON r.id = c.ruta_id
      LEFT JOIN usuarios vd
        ON vd.id = c.vendedor_id
      LEFT JOIN usuarios vr
        ON vr.id = r.vendedor_id
      LEFT JOIN frecuencias f
        ON f.id = c.frecuencia_id
      CROSS JOIN parametros p

      WHERE TRIM(c.codigo_cliente) = $1

      ORDER BY
        CASE WHEN c.deleted_at IS NULL THEN 0 ELSE 1 END,
        c.nombre
      `,
      [codigo, fecha || null]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({
        error: "No se encontró ningún cliente con ese código"
      });
    }

    const clientes = [];

    for (const cliente of resultado.rows) {
      const visitas = await db.query(
        `
        SELECT
          v.id,
          v.cliente_id,
          v.vendedor_id,
          TRIM(
            COALESCE(u.nombre, '') || ' ' || COALESCE(u.apellido, '')
          ) AS vendedor,
          v.fecha,
          v.hora_llegada,
          v.hora_salida,
          v.permanencia_segundos
        FROM visitas v
        LEFT JOIN usuarios u
          ON u.id = v.vendedor_id
        WHERE v.cliente_id = $1
          AND v.fecha = COALESCE($2::date, CURRENT_DATE)
        ORDER BY v.hora_llegada
        `,
        [cliente.id, fecha || null]
      );

      const observaciones = [];

      if (cliente.deleted_at) {
        observaciones.push("El registro está eliminado");
      }

      if (cliente.activo === false) {
        observaciones.push("El cliente está inactivo");
      }

      if (!cliente.frecuencia_id) {
        observaciones.push("No tiene frecuencia asignada");
      } else if (!cliente.corresponde_fecha) {
        observaciones.push("La frecuencia no corresponde a la fecha consultada");
      }

      if (cliente.ruta_id && cliente.ruta_activa === false) {
        observaciones.push("La ruta está inactiva");
      }

      if (!cliente.vendedor_efectivo_id) {
        observaciones.push("No tiene vendedor efectivo");
      }

      if (cliente.conflicto_vendedores) {
        observaciones.push(
          "El vendedor directo del cliente es distinto del vendedor de la ruta"
        );
      } else if (cliente.vendedor_directo_sobrante) {
        observaciones.push(
          "El cliente tiene ruta y además conserva un vendedor directo"
        );
      }

      if (visitas.rows.length > 0) {
        observaciones.push(
          `Tiene ${visitas.rows.length} visita(s) en la fecha consultada`
        );
      }

      clientes.push({
        ...cliente,
        aparece_en_plan:
          cliente.deleted_at === null &&
          cliente.activo === true &&
          cliente.corresponde_fecha === true &&
          Boolean(cliente.vendedor_efectivo_id),
        observaciones,
        visitas: visitas.rows
      });
    }

    res.json({
      resumen: {
        codigo_cliente: codigo,
        fecha: clientes[0].fecha_consulta,
        cantidad_registros: clientes.length,
        duplicado: clientes.length > 1,
        conflictos: clientes.filter(c => c.conflicto_vendedores).length,
        vendedores_sobrantes:
          clientes.filter(c => c.vendedor_directo_sobrante).length,
        visitas:
          clientes.reduce((total, c) => total + c.visitas.length, 0)
      },
      clientes
    });

  } catch (error) {
    console.error("ERROR DIAGNÓSTICO:", error);

    res.status(500).json({
      error: "Error al ejecutar el diagnóstico",
      detalle: error.message
    });
  }
});

module.exports = router;
