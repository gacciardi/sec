const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../config/database");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

function normalizarCategoria(valor) {
  const cat = String(valor || "").substring(0, 1).toUpperCase();
  return ["A", "B", "C"].includes(cat) ? cat : null;
}

function valorCampo(fila, nombre) {
  const clave = Object.keys(fila).find(
    k => k.trim().toLowerCase() === nombre.toLowerCase()
  );
  return clave ? fila[clave] : null;
}

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

router.post("/", upload.single("archivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió archivo Excel" });
    }

    const workbook = XLSX.readFile(req.file.path);
    const hoja = workbook.Sheets[workbook.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(hoja);

    let importados = 0;
    let actualizados = 0;
    let omitidos = 0;
    let suspendidos = 0;
    let reactivados = 0;
    let sinCoordenadas = 0;
    let coordenadasInvertidas = 0;
    let rutasCreadas = 0;

    const errores = [];
    const codigosImportados = [];

    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const numeroFila = i + 2;

      try {
        const codigoCliente = valorCampo(f, "codigo_cliente");

        if (!codigoCliente) {
          omitidos++;
          errores.push({ fila: numeroFila, motivo: "Sin codigo_cliente" });
          continue;
        }

        const codigoNormalizado = String(codigoCliente).trim().replace(".0", "");
        codigosImportados.push(codigoNormalizado);

        const nombre = valorCampo(f, "nombre");
        const direccion = valorCampo(f, "direccion");
        const localidad = valorCampo(f, "localidad");

        const latOriginal = valorCampo(f, "latitud");
        const lngOriginal = valorCampo(f, "longitud");

        const coords = normalizarCoordenadas(latOriginal, lngOriginal);

        const latNumero = normalizarNumero(latOriginal);
        const lngNumero = normalizarNumero(lngOriginal);

        if (
          latNumero !== null &&
          lngNumero !== null &&
          Math.abs(latNumero) > 45 &&
          Math.abs(lngNumero) < 45
        ) {
          coordenadasInvertidas++;
        }

        if (coords.latitud === null || coords.longitud === null) {
          sinCoordenadas++;
        }

        const radioGeocerca =
          normalizarNumero(valorCampo(f, "radio_geocerca")) || 30;

        const categoria = normalizarCategoria(valorCampo(f, "categoria"));

        let frecuenciaId = null;
        const frecuenciaExcel = valorCampo(f, "frecuencia");

        if (frecuenciaExcel) {
          const frecuenciaResult = await db.query(
            "SELECT id FROM frecuencias WHERE UPPER(nombre) = UPPER($1) LIMIT 1",
            [String(frecuenciaExcel).trim()]
          );

          if (frecuenciaResult.rows.length > 0) {
            frecuenciaId = frecuenciaResult.rows[0].id;
          }
        }

        let canalId = null;
        const canalExcel = valorCampo(f, "canal");

        if (canalExcel) {
          const canalResult = await db.query(
            "SELECT id FROM canales WHERE UPPER(nombre) = UPPER($1) LIMIT 1",
            [String(canalExcel).trim()]
          );

          if (canalResult.rows.length > 0) {
            canalId = canalResult.rows[0].id;
          }
        }

        let rutaId = null;
        const rutaExcel = valorCampo(f, "ruta");

        if (rutaExcel !== null && rutaExcel !== undefined && String(rutaExcel).trim() !== "") {
          const rutaNombre = String(rutaExcel).trim().replace(".0", "");

          let rutaResult = await db.query(
            "SELECT id FROM rutas WHERE UPPER(nombre) = UPPER($1) LIMIT 1",
            [rutaNombre]
          );

          if (rutaResult.rows.length === 0) {
            rutaResult = await db.query(
              `
              INSERT INTO rutas (nombre)
              VALUES ($1)
              RETURNING id
              `,
              [rutaNombre]
            );

            rutasCreadas++;
          }

          rutaId = rutaResult.rows[0].id;
        }

        const existente = await db.query(
          `
          SELECT id, activo
          FROM clientes
          WHERE codigo_cliente = $1
            AND deleted_at IS NULL
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT 1
          `,
          [codigoNormalizado]
        );

        if (existente.rows.length > 0) {
          if (existente.rows[0].activo === false) {
            reactivados++;
          }

          await db.query(
            `
            UPDATE clientes
            SET
              nombre = $1,
              direccion = $2,
              localidad = $3,
              latitud = $4,
              longitud = $5,
              radio_geocerca = $6,
              categoria = $7,
              frecuencia_id = $8,
              canal_id = $9,
              ruta_id = $10,
              activo = true,
              updated_at = NOW()
            WHERE id = $11
            `,
            [
              nombre,
              direccion,
              localidad || null,
              coords.latitud,
              coords.longitud,
              radioGeocerca,
              categoria,
              frecuenciaId,
              canalId,
              rutaId,
              existente.rows[0].id
            ]
          );

          actualizados++;
        } else {
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
              activo
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
            `,
            [
              codigoNormalizado,
              nombre,
              direccion,
              localidad || null,
              coords.latitud,
              coords.longitud,
              radioGeocerca,
              categoria,
              frecuenciaId,
              canalId,
              rutaId
            ]
          );

          importados++;
        }

      } catch (errorFila) {
        omitidos++;
        errores.push({
          fila: numeroFila,
          motivo: errorFila.message
        });
        console.error("ERROR EN FILA", numeroFila, errorFila.message);
      }
    }

    if (codigosImportados.length > 0) {
      const suspendidosResult = await db.query(
        `
        UPDATE clientes
        SET
          activo = false,
          updated_at = NOW()
        WHERE deleted_at IS NULL
          AND activo = true
          AND codigo_cliente <> ALL($1::text[])
        RETURNING id
        `,
        [codigosImportados]
      );

      suspendidos = suspendidosResult.rows.length;
    }

    res.json({
      mensaje: "Importación finalizada",
      filas: filas.length,
      importados,
      actualizados,
      reactivados,
      suspendidos,
      omitidos,
      sinCoordenadas,
      coordenadasInvertidas,
      rutasCreadas,
      errores
    });

  } catch (error) {
    console.error("ERROR IMPORTANDO EXCEL");
    console.error(error);

    res.status(500).json({
      error: "Error general al importar Excel",
      detalle: error.message
    });
  }
});

module.exports = router;