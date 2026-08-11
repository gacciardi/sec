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

          c.es_ejecucion
            AS programa_ejecucion,

          c.semana_ejecucion,

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
PLAN DE TRABAJO POR RUTA Y FECHA
=================================
*/

router.get(
  "/plan-trabajo/ruta/:ruta_id",
  async (req, res) => {
    try {

      const { ruta_id } = req.params;

      const fecha =
        String(req.query.fecha || "").trim();

      if (
        fecha &&
        !/^\d{4}-\d{2}-\d{2}$/.test(fecha)
      ) {
        return res.status(400).json({
          error:
            "La fecha debe tener formato AAAA-MM-DD"
        });
      }

      const fechaConsulta =
        fecha || null;

      /*
      =================================
      DATOS DE LA RUTA
      TITULAR + REEMPLAZO VIGENTE
      =================================
      */

      const rutaResult =
        await db.query(
          `
          SELECT

            r.id AS ruta_id,

            r.nombre AS ruta,

            r.vendedor_id
              AS vendedor_titular_id,

            TRIM(
              COALESCE(
                titular.nombre,
                ''
              )
              || ' ' ||
              COALESCE(
                titular.apellido,
                ''
              )
            )
              AS vendedor_titular,

            reemplazo.id
              AS reemplazo_id,

            reemplazo.vendedor_reemplazo_id,

            TRIM(
              COALESCE(
                vendedor_reemplazo.nombre,
                ''
              )
              || ' ' ||
              COALESCE(
                vendedor_reemplazo.apellido,
                ''
              )
            )
              AS vendedor_reemplazo,

            reemplazo.fecha_desde,

            reemplazo.fecha_hasta,

            reemplazo.motivo,

            COALESCE(
              reemplazo.vendedor_reemplazo_id,
              r.vendedor_id
            )
              AS vendedor_efectivo_id,

            CASE

              WHEN reemplazo.id IS NOT NULL
              THEN
                TRIM(
                  COALESCE(
                    vendedor_reemplazo.nombre,
                    ''
                  )
                  || ' ' ||
                  COALESCE(
                    vendedor_reemplazo.apellido,
                    ''
                  )
                )

              ELSE
                TRIM(
                  COALESCE(
                    titular.nombre,
                    ''
                  )
                  || ' ' ||
                  COALESCE(
                    titular.apellido,
                    ''
                  )
                )

            END
              AS vendedor_efectivo,

            CASE

              WHEN reemplazo.id IS NOT NULL
              THEN 'REEMPLAZO'

              ELSE 'TITULAR'

            END
              AS origen_vendedor

          FROM rutas r

          LEFT JOIN usuarios titular
            ON titular.id =
               r.vendedor_id

          LEFT JOIN LATERAL (

            SELECT
              rr.*

            FROM reemplazos_ruta rr

            WHERE
              rr.ruta_id = r.id

              AND rr.activo = true

              AND
              COALESCE(
                $2::date,
                CURRENT_DATE
              )
              BETWEEN
                rr.fecha_desde
              AND
                rr.fecha_hasta

            ORDER BY
              rr.created_at DESC

            LIMIT 1

          ) reemplazo
            ON true

          LEFT JOIN usuarios
            vendedor_reemplazo

            ON vendedor_reemplazo.id =
               reemplazo.vendedor_reemplazo_id

          WHERE
            r.id = $1

            AND r.activo = true

          LIMIT 1
          `,
          [
            ruta_id,
            fechaConsulta
          ]
        );

      if (
        rutaResult.rows.length === 0
      ) {
        return res.status(404).json({
          error:
            "Ruta no encontrada"
        });
      }

      const ruta =
        rutaResult.rows[0];

      /*
      =================================
      CLIENTES PROGRAMADOS DE LA RUTA
      =================================
      */

      const result =
        await db.query(
          `
          WITH parametros AS (

            SELECT
              COALESCE(
                $2::date,
                CURRENT_DATE
              )
                AS fecha_consulta

          ),

          programados AS (

            SELECT DISTINCT

              c.id
                AS cliente_id

            FROM clientes c

            LEFT JOIN frecuencias fr
              ON fr.id =
                 c.frecuencia_id

            CROSS JOIN parametros p

            WHERE

              c.deleted_at IS NULL

              AND c.activo = true

              AND c.ruta_id = $1

              AND (

                (
                  EXTRACT(
                    ISODOW
                    FROM p.fecha_consulta
                  ) = 1

                  AND fr.lunes = true
                )

                OR

                (
                  EXTRACT(
                    ISODOW
                    FROM p.fecha_consulta
                  ) = 2

                  AND fr.martes = true
                )

                OR

                (
                  EXTRACT(
                    ISODOW
                    FROM p.fecha_consulta
                  ) = 3

                  AND fr.miercoles = true
                )

                OR

                (
                  EXTRACT(
                    ISODOW
                    FROM p.fecha_consulta
                  ) = 4

                  AND fr.jueves = true
                )

                OR

                (
                  EXTRACT(
                    ISODOW
                    FROM p.fecha_consulta
                  ) = 5

                  AND fr.viernes = true
                )

                OR

                (
                  EXTRACT(
                    ISODOW
                    FROM p.fecha_consulta
                  ) = 6

                  AND fr.sabado = true
                )

              )

          ),

          visitas_dia AS (

            SELECT

              v.cliente_id,

              MIN(
                v.hora_llegada
              )
                AS hora_llegada,

              MAX(
                v.hora_salida
              )
                AS hora_salida,

              SUM(
                COALESCE(
                  v.permanencia_segundos,
                  0
                )
              )::int
                AS permanencia_segundos,

              COUNT(*)::int
                AS cantidad_visitas,

              STRING_AGG(

                DISTINCT

                TRIM(
                  COALESCE(
                    usuario_visita.nombre,
                    ''
                  )
                  || ' ' ||
                  COALESCE(
                    usuario_visita.apellido,
                    ''
                  )
                ),

                ', '

              )
                AS vendedores_visita

            FROM visitas v

            INNER JOIN clientes c
              ON c.id =
                 v.cliente_id

            LEFT JOIN usuarios
              usuario_visita

              ON usuario_visita.id =
                 v.vendedor_id

            CROSS JOIN parametros p

            WHERE

              v.fecha =
                p.fecha_consulta

              AND c.ruta_id = $1

              AND c.deleted_at
                  IS NULL

            GROUP BY
              v.cliente_id

          ),

           ejecuciones_dia AS (

            SELECT DISTINCT
              ced.cliente_id,
              ced.motivo

            FROM clientes_extra_dia ced

            INNER JOIN clientes c
              ON c.id = ced.cliente_id

            CROSS JOIN parametros p

            WHERE
              ced.fecha = p.fecha_consulta

              AND ced.activo = true

              AND c.deleted_at IS NULL

              AND c.activo = true

              AND ced.ruta_id = $1

          ),

          universo AS (

            SELECT
              cliente_id

            FROM programados

            UNION

            SELECT
              cliente_id

            FROM visitas_dia

            UNION

            SELECT
              cliente_id

            FROM ejecuciones_dia

          )

          SELECT

            c.id,

            c.codigo_cliente,

            c.nombre,

            c.direccion,

            c.localidad,

            c.latitud,

            c.longitud,

            c.radio_geocerca,

            ca.nombre
              AS canal,

            fr.nombre
              AS frecuencia,

            r.nombre
              AS ruta,

            (
              programados.cliente_id
              IS NOT NULL
            )
              AS programado,

            (
              visitas_dia.cliente_id
              IS NOT NULL
            )
              AS visitado,

            (
              ejecuciones_dia.cliente_id
              IS NOT NULL
            )
              AS es_ejecucion,

            ejecuciones_dia.motivo
              AS motivo_ejecucion,

            visitas_dia.hora_llegada,

            visitas_dia.hora_salida,

            COALESCE(
              visitas_dia.permanencia_segundos,
              0
            )::int
              AS permanencia_segundos,

            COALESCE(
              visitas_dia.cantidad_visitas,
              0
            )::int
              AS cantidad_visitas,

            visitas_dia.vendedores_visita,

            CASE

              WHEN
                c.latitud IS NULL

                OR c.longitud IS NULL

                OR c.latitud = 0

                OR c.longitud = 0

              THEN false

              ELSE true

            END
              AS tiene_coordenadas

          FROM universo

          INNER JOIN clientes c

            ON c.id =
               universo.cliente_id

          LEFT JOIN programados

            ON programados.cliente_id =
               c.id

           LEFT JOIN visitas_dia

            ON visitas_dia.cliente_id =
               c.id

          LEFT JOIN ejecuciones_dia

            ON ejecuciones_dia.cliente_id =
               c.id

          LEFT JOIN canales ca

            ON ca.id =
               c.canal_id

          LEFT JOIN frecuencias fr

            ON fr.id =
               c.frecuencia_id

          LEFT JOIN rutas r

            ON r.id =
               c.ruta_id

          WHERE
            c.deleted_at IS NULL

          ORDER BY

            CASE

              WHEN
                visitas_dia.cliente_id
                IS NOT NULL

              THEN 1

              ELSE 0

            END,

            c.nombre ASC
          `,
          [
            ruta_id,
            fechaConsulta
          ]
        );

      const clientes =
        result.rows;

      /*
      =================================
      RESUMEN
      =================================
      */

      const programados =
        clientes.filter(
          function(cliente) {
            return cliente.programado;
          }
        ).length;

      const visitados =
        clientes.filter(
          function(cliente) {
            return (
              cliente.programado &&
              cliente.visitado
            );
          }
        ).length;

      const pendientes =
        clientes.filter(
          function(cliente) {
            return (
              cliente.programado &&
              !cliente.visitado
            );
          }
        ).length;

      const sinCoordenadas =
        clientes.filter(
          function(cliente) {
            return (
              cliente.programado &&
              !cliente.tiene_coordenadas
            );
          }
        ).length;

      const noProgramadosVisitados =
        clientes.filter(
          function(cliente) {
            return (
              !cliente.programado &&
              cliente.visitado
            );
          }
        ).length;

      const permanenciaTotal =
        clientes.reduce(
          function(
            acumulado,
            cliente
          ) {

            return (
              acumulado +
              Number(
                cliente
                  .permanencia_segundos
                || 0
              )
            );

          },
          0
        );

      let cobertura = 0;

      if (programados > 0) {

        cobertura =
          Math.round(
            (
              visitados /
              programados
            )
            * 100
          );

      }

      /*
      =================================
      RESPUESTA
      =================================
      */

      res.json({

        fecha:
          fechaConsulta ||
          new Date()
            .toISOString()
            .slice(0, 10),

        ruta: ruta,

        resumen: {

          total:
            programados,

          programados:
            programados,

          visitados:
            visitados,

          pendientes:
            pendientes,

          sin_coordenadas:
            sinCoordenadas,

          no_programados_visitados:
            noProgramadosVisitados,

          permanencia_total_segundos:
            permanenciaTotal,

          cobertura_porcentaje:
            cobertura

        },

        clientes:
          clientes

      });

    } catch (error) {

      console.error(
        "ERROR PLAN DE TRABAJO POR RUTA:",
        error
      );

      res.status(500).json({

        error:
          "Error al obtener el plan de trabajo por ruta",

        detalle:
          error.message

      });

    }
  }
);

/*
=================================
PLAN DE TRABAJO POR VENDEDOR Y FECHA
=================================
*/

router.get(
  "/plan-trabajo/:vendedor_id",
  async (req, res) => {
    try {
      const { vendedor_id } = req.params;
      const fecha = String(req.query.fecha || "").trim();

      if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({
          error: "La fecha debe tener formato AAAA-MM-DD"
        });
      }

      const fechaConsulta = fecha || null;

      const vendedorResult = await db.query(
        `
        SELECT
          id,
          TRIM(
            COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')
          ) AS vendedor
        FROM usuarios
        WHERE id = $1
          AND rol = 'VENDEDOR'
        LIMIT 1
        `,
        [vendedor_id]
      );

      if (vendedorResult.rows.length === 0) {
        return res.status(404).json({ error: "Vendedor no encontrado" });
      }

      const result = await db.query(
        `
        WITH parametros AS (
          SELECT COALESCE($2::date, CURRENT_DATE) AS fecha_consulta
        ),
        programados AS (
          SELECT DISTINCT c.id AS cliente_id
          FROM clientes c
          LEFT JOIN rutas r ON r.id = c.ruta_id
          LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
          CROSS JOIN parametros p
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND (
              (r.vendedor_id = $1 AND r.activo = true)
              OR (r.vendedor_id IS NULL AND c.vendedor_id = $1)
            )
            AND (
              (EXTRACT(ISODOW FROM p.fecha_consulta) = 1 AND fr.lunes = true)
              OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 2 AND fr.martes = true)
              OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 3 AND fr.miercoles = true)
              OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 4 AND fr.jueves = true)
              OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 5 AND fr.viernes = true)
              OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 6 AND fr.sabado = true)
            )
        ),
        visitas_dia AS (
          SELECT
            v.cliente_id,
            MIN(v.hora_llegada) AS hora_llegada,
            MAX(v.hora_salida) AS hora_salida,
            SUM(COALESCE(v.permanencia_segundos, 0))::int AS permanencia_segundos,
            COUNT(*)::int AS cantidad_visitas
          FROM visitas v
          CROSS JOIN parametros p
          WHERE v.vendedor_id = $1
            AND v.fecha = p.fecha_consulta
          GROUP BY v.cliente_id
        ),
        ejecuciones_dia AS (
          SELECT DISTINCT
            ced.cliente_id,
            ced.motivo

          FROM clientes_extra_dia ced

          CROSS JOIN parametros p

          WHERE ced.vendedor_id = $1
            AND ced.fecha = p.fecha_consulta
            AND ced.activo = true
        ),

        universo AS (
          SELECT cliente_id FROM programados

          UNION

          SELECT cliente_id FROM visitas_dia

          UNION

          SELECT cliente_id FROM ejecuciones_dia
        )
        SELECT
          c.id,
          c.codigo_cliente,
          c.nombre,
          c.direccion,
          c.localidad,
          c.latitud,
          c.longitud,
          c.radio_geocerca,
          ca.nombre AS canal,
          fr.nombre AS frecuencia,
          r.nombre AS ruta,
           (p.cliente_id IS NOT NULL) AS programado,

          (vd.cliente_id IS NOT NULL) AS visitado,

          (ed.cliente_id IS NOT NULL) AS es_ejecucion,

          ed.motivo AS motivo_ejecucion,

          vd.hora_llegada,
          vd.hora_salida,
          COALESCE(vd.permanencia_segundos, 0)::int AS permanencia_segundos,
          COALESCE(vd.cantidad_visitas, 0)::int AS cantidad_visitas,
          CASE
            WHEN c.latitud IS NULL OR c.longitud IS NULL
              OR c.latitud = 0 OR c.longitud = 0
            THEN false
            ELSE true
          END AS tiene_coordenadas
        FROM universo u
        INNER JOIN clientes c ON c.id = u.cliente_id
        LEFT JOIN programados p
          ON p.cliente_id = c.id

        LEFT JOIN visitas_dia vd
          ON vd.cliente_id = c.id

        LEFT JOIN ejecuciones_dia ed
          ON ed.cliente_id = c.id

        LEFT JOIN canales ca
          ON ca.id = c.canal_id
        LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
        LEFT JOIN rutas r ON r.id = c.ruta_id
        WHERE c.deleted_at IS NULL
        ORDER BY
          CASE WHEN vd.cliente_id IS NOT NULL THEN 1 ELSE 0 END,
          c.nombre ASC
        `,
        [vendedor_id, fechaConsulta]
      );

      const clientes = result.rows;
      const total = clientes.length;
      const visitados = clientes.filter(c => c.visitado).length;
      const pendientes = clientes.filter(c => c.programado && !c.visitado).length;
      const sinCoordenadas = clientes.filter(c => !c.tiene_coordenadas).length;
      const noProgramadosVisitados = clientes.filter(c => !c.programado && c.visitado).length;
      const permanenciaTotal = clientes.reduce(
        (acumulado, c) => acumulado + Number(c.permanencia_segundos || 0),
        0
      );
      const cobertura = total > 0 ? Math.round((visitados / total) * 100) : 0;

      res.json({
        fecha: fechaConsulta || new Date().toISOString().slice(0, 10),
        vendedor: vendedorResult.rows[0],
        resumen: {
          total,
          visitados,
          pendientes,
          sin_coordenadas: sinCoordenadas,
          no_programados_visitados: noProgramadosVisitados,
          permanencia_total_segundos: permanenciaTotal,
          cobertura_porcentaje: cobertura
        },
        clientes
      });
    } catch (error) {
      console.error("ERROR PLAN DE TRABAJO:", error);
      res.status(500).json({
        error: "Error al obtener el plan de trabajo",
        detalle: error.message
      });
    }
  }
);

/*
=================================
CLIENTES DEL VENDEDOR HOY
INCLUYE REEMPLAZOS DE RUTA
=================================
*/

router.get(
  "/vendedor/:vendedor_id/hoy",
  async (req, res) => {
    try {

      const { vendedor_id } = req.params;

      const result = await db.query(
        `
        WITH rutas_efectivas AS (

          SELECT
            r.id AS ruta_id,

            COALESCE(
              reemplazo.vendedor_reemplazo_id,
              r.vendedor_id
            ) AS vendedor_efectivo_id

          FROM rutas r

          LEFT JOIN LATERAL (

            SELECT
              rr.vendedor_reemplazo_id

            FROM reemplazos_ruta rr

            WHERE rr.ruta_id = r.id
              AND rr.activo = true
              AND CURRENT_DATE
                  BETWEEN rr.fecha_desde
                      AND rr.fecha_hasta

            ORDER BY rr.created_at DESC

            LIMIT 1

          ) reemplazo
            ON true

          WHERE r.activo = true
        )

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
            re.vendedor_efectivo_id,
            c.vendedor_id
          ) AS vendedor_id,

          CASE

            WHEN reemplazo_usuario.id IS NOT NULL
            THEN TRIM(
              COALESCE(reemplazo_usuario.nombre, '') ||
              ' ' ||
              COALESCE(reemplazo_usuario.apellido, '')
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

        LEFT JOIN rutas_efectivas re
          ON re.ruta_id = c.ruta_id

        LEFT JOIN usuarios reemplazo_usuario
          ON reemplazo_usuario.id =
             re.vendedor_efectivo_id

        LEFT JOIN usuarios uc
          ON uc.id = c.vendedor_id

        WHERE c.deleted_at IS NULL
          AND c.activo = true

          AND (

            (
              c.ruta_id IS NOT NULL
              AND re.vendedor_efectivo_id = $1
            )

            OR

            (
              c.ruta_id IS NULL
              AND c.vendedor_id = $1
            )

          )

          AND (

            (
              EXTRACT(
                ISODOW FROM CURRENT_DATE
              ) = 1
              AND fr.lunes = true
            )

            OR

            (
              EXTRACT(
                ISODOW FROM CURRENT_DATE
              ) = 2
              AND fr.martes = true
            )

            OR

            (
              EXTRACT(
                ISODOW FROM CURRENT_DATE
              ) = 3
              AND fr.miercoles = true
            )

            OR

            (
              EXTRACT(
                ISODOW FROM CURRENT_DATE
              ) = 4
              AND fr.jueves = true
            )

            OR

            (
              EXTRACT(
                ISODOW FROM CURRENT_DATE
              ) = 5
              AND fr.viernes = true
            )

            OR

            (
              EXTRACT(
                ISODOW FROM CURRENT_DATE
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
EXPORTAR PADRON ACTUALIZADO CSV
=================================
*/

router.get(
  "/exportar/csv",
  async (req, res) => {
    try {

      const result = await db.query(`
        SELECT
          c.codigo_cliente,
          c.nombre,
          c.direccion,
          c.localidad,
          c.latitud,
          c.longitud,
          c.categoria,

          fr.nombre AS frecuencia,
          ca.nombre AS canal,
          r.nombre AS ruta,

          TRIM(
            COALESCE(
              ur.nombre,
              ud.nombre,
              ''
            )
            || ' ' ||
            COALESCE(
              ur.apellido,
              ud.apellido,
              ''
            )
          ) AS vendedor

        FROM clientes c

        LEFT JOIN frecuencias fr
          ON fr.id = c.frecuencia_id

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        LEFT JOIN rutas r
          ON r.id = c.ruta_id

        LEFT JOIN usuarios ur
          ON ur.id = r.vendedor_id

        LEFT JOIN usuarios ud
          ON ud.id = c.vendedor_id

        WHERE c.deleted_at IS NULL
          AND c.activo = true

        ORDER BY
          r.nombre,
          c.codigo_cliente
      `);

      const columnas = [
        "codigo_cliente",
        "nombre",
        "direccion",
        "localidad",
        "latitud",
        "longitud",
        "categoria",
        "frecuencia",
        "canal",
        "ruta",
        "vendedor"
      ];

      function valorCsv(valor) {

        if (
          valor === null ||
          valor === undefined
        ) {
          return "";
        }

        const texto =
          String(valor)
            .replace(/"/g, '""');

        return '"' + texto + '"';
      }

      const filas = [];

      filas.push(
        columnas.join(",")
      );

      result.rows.forEach(cliente => {

        filas.push(
          columnas
            .map(columna =>
              valorCsv(
                cliente[columna]
              )
            )
            .join(",")
        );

      });

      /*
      BOM UTF-8 para que Excel
      respete correctamente ñ y acentos.
      */
      const csv =
        "\uFEFF" +
        filas.join("\r\n");

      const fecha =
        new Date()
          .toISOString()
          .slice(0, 10);

      const nombreArchivo =
        "clientes_SEC_actualizados_" +
        fecha +
        ".csv";

      res.setHeader(
        "Content-Type",
        "text/csv; charset=utf-8"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${nombreArchivo}"`
      );

      res.send(csv);

    } catch (error) {

      console.error(
        "ERROR EXPORTANDO CLIENTES:",
        error
      );

      res.status(500).json({
        error:
          "Error al exportar padrón de clientes",

        detalle:
          error.message
      });

    }
  }
);

/*
=================================
GESTIÓN DE EJECUCIÓN
NO MODIFICA TODAVÍA EL RECORRIDO
DEL VENDEDOR.
=================================
*/

/*
GET /clientes/ejecucion/resumen

Devuelve el estado general de la clasificación
de clientes de Ejecución.
*/
router.get(
  "/ejecucion/resumen",
  async (req, res) => {
    try {
      const result =
        await db.query(`
          SELECT

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
            )::int
              AS clientes_activos,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
            )::int
              AS ejecucion_total,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
                AND semana_ejecucion = 1
            )::int
              AS semana_1,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
                AND semana_ejecucion = 2
            )::int
              AS semana_2,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
                AND semana_ejecucion = 3
            )::int
              AS semana_3,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
                AND semana_ejecucion = 4
            )::int
              AS semana_4,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
                AND semana_ejecucion = 5
            )::int
              AS semana_5,

            COUNT(*) FILTER (
              WHERE deleted_at IS NULL
                AND activo = true
                AND es_ejecucion = true
                AND semana_ejecucion IS NULL
            )::int
              AS ejecucion_sin_semana

          FROM clientes
        `);

      res.json(
        result.rows[0]
      );

    } catch (error) {
      console.error(
        "ERROR RESUMEN EJECUCION:",
        error
      );

      res.status(500).json({
        error:
          "Error al obtener resumen de Ejecución",

        detalle:
          error.message
      });
    }
  }
);

/*
GET /clientes/ejecucion

Filtros:
buscar
estado = todos | ejecucion | normal
semana = 1..5
ruta_id
limit
offset
*/
router.get(
  "/ejecucion",
  async (req, res) => {
    try {
      const buscar =
        String(
          req.query.buscar || ""
        ).trim();

      const estado =
        String(
          req.query.estado || "todos"
        )
          .trim()
          .toLowerCase();

      const rutaId =
        String(
          req.query.ruta_id || ""
        ).trim() || null;

      const semanaTexto =
        String(
          req.query.semana || ""
        ).trim();

      let semana = null;

      if (semanaTexto) {
        semana =
          Number(
            semanaTexto
          );

        if (
          !Number.isInteger(semana) ||
          semana < 1 ||
          semana > 5
        ) {
          return res.status(400).json({
            error:
              "La semana de Ejecución debe ser un número entre 1 y 5"
          });
        }
      }

      if (
        ![
          "todos",
          "ejecucion",
          "normal"
        ].includes(estado)
      ) {
        return res.status(400).json({
          error:
            "Estado de Ejecución inválido"
        });
      }

      const limit =
        Math.min(
          Math.max(
            Number(
              req.query.limit || 100
            ),
            1
          ),
          500
        );

      const offset =
        Math.max(
          Number(
            req.query.offset || 0
          ),
          0
        );

      let where = `
        WHERE c.deleted_at IS NULL
          AND c.activo = true
      `;

      const params = [];

      if (buscar) {
        params.push(
          `%${buscar.toLowerCase()}%`
        );

        const posicion =
          params.length;

        where += `
          AND (
            LOWER(
              COALESCE(
                c.codigo_cliente,
                ''
              )
            ) LIKE $${posicion}

            OR LOWER(
              COALESCE(
                c.nombre,
                ''
              )
            ) LIKE $${posicion}

            OR LOWER(
              COALESCE(
                c.direccion,
                ''
              )
            ) LIKE $${posicion}

            OR LOWER(
              COALESCE(
                c.localidad,
                ''
              )
            ) LIKE $${posicion}

            OR LOWER(
              COALESCE(
                r.nombre,
                ''
              )
            ) LIKE $${posicion}
          )
        `;
      }

      if (
        estado === "ejecucion"
      ) {
        where += `
          AND c.es_ejecucion = true
        `;
      }

      if (
        estado === "normal"
      ) {
        where += `
          AND c.es_ejecucion = false
        `;
      }

      if (semana !== null) {
        params.push(
          semana
        );

        const posicion =
          params.length;

        where += `
          AND c.es_ejecucion = true
          AND c.semana_ejecucion =
              $${posicion}::int
        `;
      }

      if (rutaId) {
        params.push(
          rutaId
        );

        const posicion =
          params.length;

        where += `
          AND c.ruta_id =
              $${posicion}::uuid
        `;
      }

      const totalResult =
        await db.query(
          `
          SELECT
            COUNT(*)::int
              AS total

          FROM clientes c

          LEFT JOIN rutas r
            ON r.id =
               c.ruta_id

          ${where}
          `,
          params
        );

      params.push(
        limit
      );

      const posicionLimit =
        params.length;

      params.push(
        offset
      );

      const posicionOffset =
        params.length;

      const result =
        await db.query(
          `
          SELECT

            c.id,

            c.codigo_cliente,

            c.nombre,

            c.direccion,

            c.localidad,

            c.categoria,

            c.ruta_id,

            r.nombre
              AS ruta,

            c.frecuencia_id,

            fr.nombre
              AS frecuencia,

            c.es_ejecucion,

            c.semana_ejecucion,

            r.vendedor_id
              AS vendedor_ruta_id,

            TRIM(
              COALESCE(
                ur.nombre,
                ''
              )
              || ' ' ||
              COALESCE(
                ur.apellido,
                ''
              )
            )
              AS vendedor_ruta

          FROM clientes c

          LEFT JOIN rutas r
            ON r.id =
               c.ruta_id

          LEFT JOIN frecuencias fr
            ON fr.id =
               c.frecuencia_id

          LEFT JOIN usuarios ur
            ON ur.id =
               r.vendedor_id

          ${where}

          ORDER BY
            CASE
              WHEN c.es_ejecucion = true
              THEN 0
              ELSE 1
            END,

            c.semana_ejecucion
              NULLS LAST,

            r.nombre
              NULLS LAST,

            c.nombre,

            c.codigo_cliente

          LIMIT
            $${posicionLimit}

          OFFSET
            $${posicionOffset}
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
        "ERROR LISTANDO EJECUCION:",
        error
      );

      res.status(500).json({
        error:
          "Error al obtener clientes de Ejecución",

        detalle:
          error.message
      });
    }
  }
);

/*
PATCH /clientes/ejecucion/masivo

BODY:
{
  "cliente_ids": ["uuid", ...]
  // o
  "codigos_cliente": ["1001", "1002", ...],

  "es_ejecucion": true,
  "semana_ejecucion": 1
}

Si es_ejecucion = false:
semana_ejecucion se limpia automáticamente.
*/
router.patch(
  "/ejecucion/masivo",
  async (req, res) => {
    try {
      const {
        cliente_ids,
        codigos_cliente,
        es_ejecucion,
        semana_ejecucion
      } = req.body || {};

      if (
        typeof es_ejecucion !==
        "boolean"
      ) {
        return res.status(400).json({
          error:
            "Debe indicar es_ejecucion como true o false"
        });
      }

      let semana = null;

      if (es_ejecucion) {
        semana =
          Number(
            semana_ejecucion
          );

        if (
          !Number.isInteger(semana) ||
          semana < 1 ||
          semana > 5
        ) {
          return res.status(400).json({
            error:
              "Para marcar clientes como Ejecución debe indicar una semana entre 1 y 5"
          });
        }
      }

      const ids =
        Array.isArray(cliente_ids)
          ? [
              ...new Set(
                cliente_ids
                  .map(valor =>
                    String(valor || "")
                      .trim()
                  )
                  .filter(Boolean)
              )
            ]
          : [];

      const codigos =
        Array.isArray(
          codigos_cliente
        )
          ? [
              ...new Set(
                codigos_cliente
                  .map(valor =>
                    String(valor || "")
                      .trim()
                      .replace(/\.0$/, "")
                  )
                  .filter(Boolean)
              )
            ]
          : [];

      if (
        ids.length === 0 &&
        codigos.length === 0
      ) {
        return res.status(400).json({
          error:
            "Debe indicar al menos un cliente o código de cliente"
        });
      }

      let result;

      if (ids.length > 0) {
        result =
          await db.query(
            `
            UPDATE clientes
            SET
              es_ejecucion = $1,
              semana_ejecucion = $2,
              updated_at = NOW()

            WHERE deleted_at IS NULL
              AND id =
                  ANY($3::uuid[])

            RETURNING
              id,
              codigo_cliente,
              nombre,
              es_ejecucion,
              semana_ejecucion
            `,
            [
              es_ejecucion,
              semana,
              ids
            ]
          );

      } else {
        result =
          await db.query(
            `
            UPDATE clientes
            SET
              es_ejecucion = $1,
              semana_ejecucion = $2,
              updated_at = NOW()

            WHERE deleted_at IS NULL
              AND codigo_cliente =
                  ANY($3::text[])

            RETURNING
              id,
              codigo_cliente,
              nombre,
              es_ejecucion,
              semana_ejecucion
            `,
            [
              es_ejecucion,
              semana,
              codigos
            ]
          );
      }

      /*
      Control de códigos no encontrados.
      Permite que el Supervisor informe exactamente
      cuáles códigos no pudieron actualizarse.
      */
      const codigosEncontrados =
        new Set(
          result.rows
            .map(cliente =>
              String(
                cliente.codigo_cliente || ""
              )
                .trim()
                .replace(/\.0$/, "")
            )
            .filter(Boolean)
        );

      const codigosNoEncontrados =
        codigos.length > 0
          ? codigos.filter(
              codigo =>
                !codigosEncontrados.has(
                  String(codigo)
                    .trim()
                    .replace(/\.0$/, "")
                )
            )
          : [];

      const cantidadIngresados =
        ids.length > 0
          ? ids.length
          : codigos.length;

      res.json({
        mensaje:
          es_ejecucion
            ? "Clientes marcados como Ejecución"
            : "Clientes quitados de Ejecución",

        ingresados:
          cantidadIngresados,

        encontrados:
          result.rows.length,

        actualizados:
          result.rows.length,

        no_encontrados:
          codigosNoEncontrados.length,

        codigos_no_encontrados:
          codigosNoEncontrados,

        clientes:
          result.rows
      });

    } catch (error) {
      console.error(
        "ERROR ACTUALIZACION MASIVA EJECUCION:",
        error
      );

      res.status(500).json({
        error:
          "Error al actualizar clientes de Ejecución",

        detalle:
          error.message
      });
    }
  }
);

/*
PATCH /clientes/:id/ejecucion

BODY:
{
  "es_ejecucion": true,
  "semana_ejecucion": 1
}
*/
router.patch(
  "/:id/ejecucion",
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        es_ejecucion,
        semana_ejecucion
      } = req.body || {};

      if (
        typeof es_ejecucion !==
        "boolean"
      ) {
        return res.status(400).json({
          error:
            "Debe indicar es_ejecucion como true o false"
        });
      }

      let semana = null;

      if (es_ejecucion) {
        semana =
          Number(
            semana_ejecucion
          );

        if (
          !Number.isInteger(semana) ||
          semana < 1 ||
          semana > 5
        ) {
          return res.status(400).json({
            error:
              "Para marcar el cliente como Ejecución debe indicar una semana entre 1 y 5"
          });
        }
      }

      const result =
        await db.query(
          `
          UPDATE clientes
          SET
            es_ejecucion = $1,
            semana_ejecucion = $2,
            updated_at = NOW()

          WHERE id = $3
            AND deleted_at IS NULL

          RETURNING
            id,
            codigo_cliente,
            nombre,
            ruta_id,
            frecuencia_id,
            es_ejecucion,
            semana_ejecucion
          `,
          [
            es_ejecucion,
            semana,
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
          es_ejecucion
            ? "Cliente marcado como Ejecución"
            : "Cliente quitado de Ejecución",

        cliente:
          result.rows[0]
      });

    } catch (error) {
      console.error(
        "ERROR ACTUALIZANDO EJECUCION:",
        error
      );

      res.status(500).json({
        error:
          "Error al actualizar Ejecución del cliente",

        detalle:
          error.message
      });
    }
  }
);

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