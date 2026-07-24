const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../config/database");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

/*
=================================
FUNCIONES DE NORMALIZACIÓN
=================================
*/

function valorCampo(fila, nombre) {
  const clave = Object.keys(fila).find(
    k =>
      String(k)
        .trim()
        .toLowerCase() ===
      String(nombre)
        .trim()
        .toLowerCase()
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

  const texto = String(valor)
    .trim()
    .replace(/\s+/g, " ");

  return texto === ""
    ? null
    : texto;
}

function normalizarTextoComparacion(valor) {
  const texto = limpiarTexto(valor);

  if (!texto) {
    return "";
  }

  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
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
  const categoria = String(valor || "")
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

/*
=================================
BÚSQUEDAS AUXILIARES
=================================
*/

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
    SELECT
      id,
      nombre,
      vendedor_id
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
      nombre: result.rows[0].nombre,
      vendedorIdActual:
        result.rows[0].vendedor_id
    };
  }

  result = await db.query(
    `
    INSERT INTO rutas (
      nombre,
      activo
    )
    VALUES ($1, true)
    RETURNING
      id,
      nombre,
      vendedor_id
    `,
    [rutaNombre]
  );

  return {
    rutaId: result.rows[0].id,
    creada: true,
    nombre: result.rows[0].nombre,
    vendedorIdActual: null
  };
}

async function cargarVendedores() {
  const result = await db.query(
    `
    SELECT
      id,
      nombre,
      apellido,
      legajo,
      activo
    FROM usuarios
    WHERE UPPER(TRIM(rol)) = 'VENDEDOR'
    ORDER BY nombre, apellido
    `
  );

  return result.rows.map(vendedor => {
    const nombreCompleto =
      limpiarTexto(
        `${vendedor.nombre || ""} ${vendedor.apellido || ""}`
      ) || "";

    const apellidoNombre =
      limpiarTexto(
        `${vendedor.apellido || ""} ${vendedor.nombre || ""}`
      ) || "";

    return {
      ...vendedor,

      nombre_completo:
        nombreCompleto,

      clave_nombre:
        normalizarTextoComparacion(
          nombreCompleto
        ),

      clave_apellido_nombre:
        normalizarTextoComparacion(
          apellidoNombre
        )
    };
  });
}

function buscarVendedorPorNombre(
  vendedores,
  valorExcel
) {
  const nombreExcel =
    limpiarTexto(valorExcel);

  if (!nombreExcel) {
    return {
      vendedor: null,
      valorBuscado: null,
      coincidencias: []
    };
  }

  const clave =
    normalizarTextoComparacion(
      nombreExcel
    );

  const coincidencias =
    vendedores.filter(vendedor =>
      vendedor.clave_nombre === clave ||
      vendedor.clave_apellido_nombre === clave
    );

  return {
    vendedor:
      coincidencias.length === 1
        ? coincidencias[0]
        : null,

    valorBuscado:
      nombreExcel,

    coincidencias
  };
}

/*
=================================
IMPORTAR CLIENTES
=================================
*/

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

      const vendedores =
        await cargarVendedores();

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

      const vendedoresEncontrados =
        new Set();

      /*
      Evita que dentro del mismo Excel una ruta
      sea asignada a dos vendedores diferentes.
      */
      const asignacionesRuta =
        new Map();

      for (
        let indice = 0;
        indice < filas.length;
        indice++
      ) {
        const fila =
          filas[indice];

        const numeroFila =
          indice + 2;

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
                "La fila no tiene codigo_cliente"
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

          if (
            coordenadas.invertidas
          ) {
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

          const frecuenciaExcel =
            valorCampo(
              fila,
              "frecuencia"
            );

          const canalExcel =
            valorCampo(
              fila,
              "canal"
            );

          const frecuenciaId =
            await buscarFrecuencia(
              frecuenciaExcel
            );

          const canalId =
            await buscarCanal(
              canalExcel
            );

          if (
            limpiarTexto(frecuenciaExcel) &&
            !frecuenciaId
          ) {
            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              motivo:
                `No se encontró la frecuencia: ` +
                `${limpiarTexto(frecuenciaExcel)}`
            });
          }

          if (
            limpiarTexto(canalExcel) &&
            !canalId
          ) {
            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              motivo:
                `No se encontró el canal: ` +
                `${limpiarTexto(canalExcel)}`
            });
          }

          const rutaResultado =
            await obtenerOCrearRuta(
              valorCampo(
                fila,
                "ruta"
              )
            );

          const rutaId =
            rutaResultado.rutaId;

          if (
            rutaResultado.creada
          ) {
            rutasCreadas++;
          }

          /*
          La columna del Excel debe llamarse:
          vendedor
          */
          const vendedorResultado =
            buscarVendedorPorNombre(
              vendedores,
              valorCampo(
                fila,
                "vendedor"
              )
            );

          const vendedor =
            vendedorResultado.vendedor;

          if (
            vendedorResultado.valorBuscado &&
            vendedorResultado.coincidencias.length === 0
          ) {
            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              vendedor:
                vendedorResultado.valorBuscado,
              motivo:
                `No se encontró el vendedor ` +
                `"${vendedorResultado.valorBuscado}" ` +
                `en Usuarios`
            });
          }

          if (
            vendedorResultado.valorBuscado &&
            vendedorResultado.coincidencias.length > 1
          ) {
            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              vendedor:
                vendedorResultado.valorBuscado,
              motivo:
                `Hay más de un vendedor que coincide ` +
                `con "${vendedorResultado.valorBuscado}". ` +
                `No se modificó la asignación.`
            });
          }

          if (vendedor) {
            vendedoresEncontrados.add(
              vendedor.id
            );

            if (
              vendedor.activo === false
            ) {
              advertencias.push({
                fila: numeroFila,
                codigo_cliente:
                  codigoCliente,
                vendedor:
                  vendedor.nombre_completo,
                motivo:
                  "El vendedor está inactivo, pero fue encontrado"
              });
            }
          }

          /*
          Si hay ruta y vendedor, la asignación
          se realiza sobre la ruta.
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
                  `en el Excel. Se conservó el primero.`
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

          /*
          =============================
          ACTUALIZAR CLIENTE EXISTENTE
          =============================
          */

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
            Si hay ruta, el vendedor efectivo
            se obtiene desde la ruta.

            Si no hay ruta, se puede asignar
            directamente al cliente.
            */
            let vendedorDirecto = null;

            if (
              !rutaId &&
              vendedor
            ) {
              vendedorDirecto =
                vendedor.id;

              if (
                clienteActual.vendedor_id !==
                vendedor.id
              ) {
                clientesAsignadosDirectamente++;
              }
            }

            /*
            IMPORTANTE:
            Las coordenadas corregidas desde SEC tienen prioridad.
            Si el cliente ya posee latitud y longitud válidas en la
            base, el importador NO las reemplaza por las del archivo.
            Solamente toma las coordenadas importadas cuando el cliente
            todavía no tiene coordenadas válidas guardadas.
            */
            const latitudActual =
              normalizarNumero(clienteActual.latitud);

            const longitudActual =
              normalizarNumero(clienteActual.longitud);

            const tieneCoordenadasActuales =
              latitudActual !== null &&
              longitudActual !== null &&
              latitudActual !== 0 &&
              longitudActual !== 0;

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
                tieneCoordenadasActuales
                  ? clienteActual.latitud
                  : coordenadas.latitud,

              longitud:
                tieneCoordenadasActuales
                  ? clienteActual.longitud
                  : coordenadas.longitud,

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
              String(
                clienteActual.nombre ?? ""
              ) !==
                String(
                  valoresNuevos.nombre ?? ""
                ) ||

              String(
                clienteActual.direccion ?? ""
              ) !==
                String(
                  valoresNuevos.direccion ?? ""
                ) ||

              String(
                clienteActual.localidad ?? ""
              ) !==
                String(
                  valoresNuevos.localidad ?? ""
                ) ||

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
            /*
            =============================
            CREAR CLIENTE NUEVO
            =============================
            */

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
      Los clientes que no aparecen en el nuevo
      padrón quedan suspendidos.
      */
      if (
        codigosImportados.length > 0
      ) {
        const codigosUnicos = [
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

        vendedoresEncontrados:
          vendedoresEncontrados.size,

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