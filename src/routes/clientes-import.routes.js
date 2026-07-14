const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../config/database");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

function valorCampo(fila, nombre) {
  const clave = Object.keys(fila).find(
    k => k.trim().toLowerCase() === nombre.toLowerCase()
  );

  return clave ? fila[clave] : null;
}

function limpiarTexto(valor) {
  if (
    valor === null ||
    valor === undefined
  ) {
    return null;
  }

  const texto = String(valor).trim();

  return texto === ""
    ? null
    : texto;
}

function normalizarCodigo(valor) {
  const texto = limpiarTexto(valor);

  if (!texto) {
    return null;
  }

  return texto.replace(/\.0$/, "");
}

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

function normalizarCategoria(valor) {
  const categoria = String(
    valor || ""
  )
    .trim()
    .substring(0, 1)
    .toUpperCase();

  return ["A", "B", "C"].includes(categoria)
    ? categoria
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

  let invertidas = false;

  if (
    latitud !== null &&
    longitud !== null &&
    Math.abs(latitud) > 45 &&
    Math.abs(longitud) < 45
  ) {
    const temporal = latitud;

    latitud = longitud;
    longitud = temporal;
    invertidas = true;
  }

  return {
    latitud,
    longitud,
    invertidas
  };
}

async function buscarFrecuencia(valor) {
  const nombre = limpiarTexto(valor);

  if (!nombre) {
    return null;
  }

  const result = await db.query(
    `
    SELECT id
    FROM frecuencias
    WHERE UPPER(TRIM(nombre)) =
          UPPER(TRIM($1))
    LIMIT 1
    `,
    [nombre]
  );

  return result.rows[0]?.id || null;
}

async function buscarCanal(valor) {
  const nombre = limpiarTexto(valor);

  if (!nombre) {
    return null;
  }

  const result = await db.query(
    `
    SELECT id
    FROM canales
    WHERE UPPER(TRIM(nombre)) =
          UPPER(TRIM($1))
    LIMIT 1
    `,
    [nombre]
  );

  return result.rows[0]?.id || null;
}

async function obtenerOCrearRuta(valor) {
  const rutaNombre =
    normalizarCodigo(valor);

  if (!rutaNombre) {
    return {
      rutaId: null,
      creada: false,
      nombre: null
    };
  }

  let result = await db.query(
    `
    SELECT id, nombre
    FROM rutas
    WHERE UPPER(TRIM(nombre)) =
          UPPER(TRIM($1))
    LIMIT 1
    `,
    [rutaNombre]
  );

  if (result.rows.length > 0) {
    return {
      rutaId: result.rows[0].id,
      creada: false,
      nombre: result.rows[0].nombre
    };
  }

  result = await db.query(
    `
    INSERT INTO rutas (
      nombre,
      activo
    )
    VALUES ($1, true)
    RETURNING id, nombre
    `,
    [rutaNombre]
  );

  return {
    rutaId: result.rows[0].id,
    creada: true,
    nombre: result.rows[0].nombre
  };
}

async function buscarVendedor(fila) {
  const legajo =
    normalizarCodigo(
      valorCampo(
        fila,
        "legajo_vendedor"
      )
    );

  const vendedorTexto =
    limpiarTexto(
      valorCampo(
        fila,
        "vendedor"
      )
    );

  /*
  Primero intenta por legajo, porque es
  el dato más seguro.
  */
  if (legajo) {
    const porLegajo = await db.query(
      `
      SELECT
        id,
        nombre,
        apellido,
        legajo
      FROM usuarios
      WHERE UPPER(rol) = 'VENDEDOR'
        AND TRIM(CAST(legajo AS TEXT)) =
            TRIM($1)
      LIMIT 1
      `,
      [legajo]
    );

    if (porLegajo.rows.length > 0) {
      return {
        vendedor: porLegajo.rows[0],
        buscadoPor: "legajo",
        valorBuscado: legajo
      };
    }

    return {
      vendedor: null,
      buscadoPor: "legajo",
      valorBuscado: legajo
    };
  }

  /*
  Si no hay legajo, intenta por nombre
  completo.
  */
  if (vendedorTexto) {
    const porNombre = await db.query(
      `
      SELECT
        id,
        nombre,
        apellido,
        legajo
      FROM usuarios
      WHERE UPPER(rol) = 'VENDEDOR'
        AND UPPER(
          TRIM(
            nombre || ' ' || apellido
          )
        ) = UPPER(TRIM($1))
      LIMIT 1
      `,
      [vendedorTexto]
    );

    if (porNombre.rows.length > 0) {
      return {
        vendedor: porNombre.rows[0],
        buscadoPor: "nombre",
        valorBuscado: vendedorTexto
      };
    }

    return {
      vendedor: null,
      buscadoPor: "nombre",
      valorBuscado: vendedorTexto
    };
  }

  return {
    vendedor: null,
    buscadoPor: null,
    valorBuscado: null
  };
}

router.post(
  "/",
  upload.single("archivo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "No se recibió archivo Excel"
        });
      }

      const workbook =
        XLSX.readFile(req.file.path);

      const hoja =
        workbook.Sheets[
          workbook.SheetNames[0]
        ];

      const filas =
        XLSX.utils.sheet_to_json(
          hoja,
          {
            defval: null
          }
        );

      let importados = 0;
      let actualizados = 0;
      let sinCambios = 0;
      let omitidos = 0;
      let suspendidos = 0;
      let reactivados = 0;
      let rutasCreadas = 0;
      let rutasAsignadas = 0;
      let clientesAsignadosDirectamente = 0;
      let sinCoordenadas = 0;
      let coordenadasInvertidas = 0;

      const errores = [];
      const advertencias = [];
      const codigosImportados = [];

      /*
      Sirve para detectar que una misma ruta
      no venga con dos vendedores diferentes
      dentro del mismo Excel.
      */
      const asignacionesRuta =
        new Map();

      for (
        let indice = 0;
        indice < filas.length;
        indice++
      ) {
        const fila = filas[indice];
        const numeroFila = indice + 2;

        try {
          const codigoCliente =
            normalizarCodigo(
              valorCampo(
                fila,
                "codigo_cliente"
              )
            );

          if (!codigoCliente) {
            omitidos++;

            errores.push({
              fila: numeroFila,
              motivo:
                "Sin codigo_cliente"
            });

            continue;
          }

          codigosImportados.push(
            codigoCliente
          );

          const nombre =
            limpiarTexto(
              valorCampo(
                fila,
                "nombre"
              )
            );

          const direccion =
            limpiarTexto(
              valorCampo(
                fila,
                "direccion"
              )
            );

          const localidad =
            limpiarTexto(
              valorCampo(
                fila,
                "localidad"
              )
            );

          const coordenadas =
            normalizarCoordenadas(
              valorCampo(
                fila,
                "latitud"
              ),
              valorCampo(
                fila,
                "longitud"
              )
            );

          if (coordenadas.invertidas) {
            coordenadasInvertidas++;
          }

          if (
            coordenadas.latitud === null ||
            coordenadas.longitud === null
          ) {
            sinCoordenadas++;
          }

          const categoria =
            normalizarCategoria(
              valorCampo(
                fila,
                "categoria"
              )
            );

          const frecuenciaId =
            await buscarFrecuencia(
              valorCampo(
                fila,
                "frecuencia"
              )
            );

          const canalId =
            await buscarCanal(
              valorCampo(
                fila,
                "canal"
              )
            );

          const rutaResultado =
            await obtenerOCrearRuta(
              valorCampo(
                fila,
                "ruta"
              )
            );

          const rutaId =
            rutaResultado.rutaId;

          if (rutaResultado.creada) {
            rutasCreadas++;
          }

          const vendedorResultado =
            await buscarVendedor(fila);

          const vendedor =
            vendedorResultado.vendedor;

          /*
          Si se escribió un vendedor pero no
          existe en SEC, se informa y no se
          pisa ninguna asignación anterior.
          */
          if (
            vendedorResultado.valorBuscado &&
            !vendedor
          ) {
            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              motivo:
                `No se encontró el vendedor por ` +
                `${vendedorResultado.buscadoPor}: ` +
                `${vendedorResultado.valorBuscado}`
            });
          }

          /*
          Si hay ruta y vendedor, se asigna
          el vendedor a la ruta.
          */
          if (
            rutaId &&
            vendedor
          ) {
            const vendedorRutaPrevio =
              asignacionesRuta.get(
                rutaId
              );

            if (
              vendedorRutaPrevio &&
              vendedorRutaPrevio !==
                vendedor.id
            ) {
              advertencias.push({
                fila: numeroFila,
                codigo_cliente:
                  codigoCliente,
                motivo:
                  `La ruta ${rutaResultado.nombre} ` +
                  `aparece con más de un vendedor ` +
                  `en el mismo Excel. Se conservó ` +
                  `la primera asignación.`
              });

            } else {
              asignacionesRuta.set(
                rutaId,
                vendedor.id
              );

              const cambioRuta =
                await db.query(
                  `
                  UPDATE rutas
                  SET
                    vendedor_id = $1,
                    activo = true,
                    updated_at = NOW()
                  WHERE id = $2
                    AND vendedor_id
                      IS DISTINCT FROM $1
                  RETURNING id
                  `,
                  [
                    vendedor.id,
                    rutaId
                  ]
                );

              if (
                cambioRuta.rows.length > 0
              ) {
                rutasAsignadas++;
              }
            }
          }

          const existente =
            await db.query(
              `
              SELECT *
              FROM clientes
              WHERE codigo_cliente = $1
                AND deleted_at IS NULL
              ORDER BY
                updated_at DESC NULLS LAST,
                created_at DESC NULLS LAST
              LIMIT 1
              `,
              [codigoCliente]
            );

          if (
            existente.rows.length > 0
          ) {
            const clienteActual =
              existente.rows[0];

            if (
              clienteActual.activo === false
            ) {
              reactivados++;
            }

            /*
            Cuando hay ruta, el vendedor queda
            administrado por la ruta.

            Si no hay ruta y el Excel trae
            vendedor, se asigna directamente.
            Si no trae vendedor, conserva el
            existente.
            */
            let vendedorDirecto =
              clienteActual.vendedor_id;

            if (
              !rutaId &&
              vendedor
            ) {
              vendedorDirecto =
                vendedor.id;

              clientesAsignadosDirectamente++;
            }

            const valoresNuevos = {
              nombre:
                nombre ??
                clienteActual.nombre,

              direccion:
                direccion ??
                clienteActual.direccion,

              localidad:
                localidad ??
                clienteActual.localidad,

              latitud:
                coordenadas.latitud ??
                clienteActual.latitud,

              longitud:
                coordenadas.longitud ??
                clienteActual.longitud,

              categoria:
                categoria ??
                clienteActual.categoria,

              frecuencia_id:
                frecuenciaId ??
                clienteActual.frecuencia_id,

              canal_id:
                canalId ??
                clienteActual.canal_id,

              ruta_id:
                rutaId ??
                clienteActual.ruta_id,

              vendedor_id:
                vendedorDirecto,

              radio_geocerca: 30,
              activo: true
            };

            const cambio =
              clienteActual.nombre !==
                valoresNuevos.nombre ||

              clienteActual.direccion !==
                valoresNuevos.direccion ||

              clienteActual.localidad !==
                valoresNuevos.localidad ||

              Number(
                clienteActual.latitud
              ) !==
                Number(
                  valoresNuevos.latitud
                ) ||

              Number(
                clienteActual.longitud
              ) !==
                Number(
                  valoresNuevos.longitud
                ) ||

              clienteActual.categoria !==
                valoresNuevos.categoria ||

              clienteActual.frecuencia_id !==
                valoresNuevos.frecuencia_id ||

              clienteActual.canal_id !==
                valoresNuevos.canal_id ||

              clienteActual.ruta_id !==
                valoresNuevos.ruta_id ||

              clienteActual.vendedor_id !==
                valoresNuevos.vendedor_id ||

              Number(
                clienteActual.radio_geocerca
              ) !== 30 ||

              clienteActual.activo !== true;

            await db.query(
              `
              UPDATE clientes
              SET
                nombre = $1,
                direccion = $2,
                localidad = $3,
                latitud = $4,
                longitud = $5,
                radio_geocerca = 30,
                categoria = $6,
                frecuencia_id = $7,
                canal_id = $8,
                ruta_id = $9,
                vendedor_id = $10,
                activo = true,
                updated_at =
                  CASE
                    WHEN $11::boolean = true
                    THEN NOW()
                    ELSE updated_at
                  END
              WHERE id = $12
              `,
              [
                valoresNuevos.nombre,
                valoresNuevos.direccion,
                valoresNuevos.localidad,
                valoresNuevos.latitud,
                valoresNuevos.longitud,
                valoresNuevos.categoria,
                valoresNuevos.frecuencia_id,
                valoresNuevos.canal_id,
                valoresNuevos.ruta_id,
                valoresNuevos.vendedor_id,
                cambio,
                clienteActual.id
              ]
            );

            if (cambio) {
              actualizados++;
            } else {
              sinCambios++;
            }

          } else {
            const vendedorDirecto =
              !rutaId && vendedor
                ? vendedor.id
                : null;

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
                categoria,
                frecuencia_id,
                canal_id,
                ruta_id,
                vendedor_id,
                activo
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                30,
                $7,
                $8,
                $9,
                $10,
                $11,
                true
              )
              `,
              [
                codigoCliente,
                nombre,
                direccion,
                localidad,
                coordenadas.latitud,
                coordenadas.longitud,
                categoria,
                frecuenciaId,
                canalId,
                rutaId,
                vendedorDirecto
              ]
            );

            if (vendedorDirecto) {
              clientesAsignadosDirectamente++;
            }

            importados++;
          }

        } catch (errorFila) {
          omitidos++;

          errores.push({
            fila: numeroFila,
            motivo:
              errorFila.message
          });

          console.error(
            "ERROR EN FILA",
            numeroFila,
            errorFila.message
          );
        }
      }

      /*
      Los clientes que no vienen en el nuevo
      padrón quedan suspendidos.
      */
      if (
        codigosImportados.length > 0
      ) {
        const codigosUnicos =
          [
            ...new Set(
              codigosImportados
            )
          ];

        const resultadoSuspendidos =
          await db.query(
            `
            UPDATE clientes
            SET
              activo = false,
              updated_at = NOW()
            WHERE deleted_at IS NULL
              AND activo = true
              AND codigo_cliente
                <> ALL($1::text[])
            RETURNING id
            `,
            [codigosUnicos]
          );

        suspendidos =
          resultadoSuspendidos.rows.length;
      }

      res.json({
        mensaje:
          "Importación finalizada",

        filas:
          filas.length,

        importados,
        actualizados,
        sinCambios,
        reactivados,
        suspendidos,
        omitidos,

        sinCoordenadas,
        coordenadasInvertidas,

        rutasCreadas,
        rutasAsignadas,

        clientesAsignadosDirectamente,

        advertencias,
        errores
      });

    } catch (error) {
      console.error(
        "ERROR IMPORTANDO EXCEL",
        error
      );

      res.status(500).json({
        error:
          "Error general al importar Excel",

        detalle:
          error.message
      });
    }
  }
);

module.exports = router;