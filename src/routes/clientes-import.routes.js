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

function limpiarTexto(valor) {
  if (valor === null || valor === undefined) return null;
  const txt = String(valor).trim();
  return txt === "" ? null : txt;
}

function normalizarCodigo(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  return String(valor).trim().replace(".0", "");
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
    let sinCambios = 0;
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
        const codigoNormalizado = normalizarCodigo(valorCampo(f, "codigo_cliente"));

        if (!codigoNormalizado) {
          omitidos++;
          errores.push({ fila: numeroFila, motivo: "Sin codigo_cliente" });
          continue;
        }

        codigosImportados.push(codigoNormalizado);

        const nombre = limpiarTexto(valorCampo(f, "nombre"));
        const direccion = limpiarTexto(valorCampo(f, "direccion"));
        const localidad = limpiarTexto(valorCampo(f, "localidad"));

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

        const radioGeocerca = 30;
        const categoria = normalizarCategoria(valorCampo(f, "categoria"));

        let frecuenciaId = null;
        const frecuenciaExcel = limpiarTexto(valorCampo(f, "frecuencia"));

        if (frecuenciaExcel) {
          const frecuenciaResult = await db.query(
            "SELECT id FROM frecuencias WHERE UPPER(nombre) = UPPER($1) LIMIT 1",
            [frecuenciaExcel]
          );
          if (frecuenciaResult.rows.length > 0) frecuenciaId = frecuenciaResult.rows[0].id;
        }

        let canalId = null;
        const canalExcel = limpiarTexto(valorCampo(f, "canal"));

        if (canalExcel) {
          const canalResult = await db.query(
            "SELECT id FROM canales WHERE UPPER(nombre) = UPPER($1) LIMIT 1",
            [canalExcel]
          );
          if (canalResult.rows.length > 0) canalId = canalResult.rows[0].id;
        }

        let rutaId = null;
        const rutaExcel = limpiarTexto(valorCampo(f, "ruta"));

        if (rutaExcel) {
          const rutaNombre = rutaExcel.replace(".0", "");

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
          SELECT *
          FROM clientes
          WHERE codigo_cliente = $1
            AND deleted_at IS NULL
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT 1
          `,
          [codigoNormalizado]
        );

        if (existente.rows.length > 0) {
          const c = existente.rows[0];

          if (c.activo === false) reactivados++;

          const result = await db.query(
            `
            UPDATE clientes
            SET
              nombre = COALESCE($1, nombre),
              direccion = COALESCE($2, direccion),
              localidad = COALESCE($3, localidad),
              latitud = COALESCE($4, latitud),
              longitud = COALESCE($5, longitud),
              radio_geocerca = 30,
              categoria = COALESCE($6, categoria),
              frecuencia_id = COALESCE($7, frecuencia_id),
              canal_id = COALESCE($8, canal_id),
              ruta_id = COALESCE($9, ruta_id),
              activo = true,
              updated_at = CASE
                WHEN
                  nombre IS DISTINCT FROM COALESCE($1, nombre)
                  OR direccion IS DISTINCT FROM COALESCE($2, direccion)
                  OR localidad IS DISTINCT FROM COALESCE($3, localidad)
                  OR latitud IS DISTINCT FROM COALESCE($4, latitud)
                  OR longitud IS DISTINCT FROM COALESCE($5, longitud)
                  OR radio_geocerca IS DISTINCT FROM 30
                  OR categoria IS DISTINCT FROM COALESCE($6, categoria)
                  OR frecuencia_id IS DISTINCT FROM COALESCE($7, frecuencia_id)
                  OR canal_id IS DISTINCT FROM COALESCE($8, canal_id)
                  OR ruta_id IS DISTINCT FROM COALESCE($9, ruta_id)
                  OR activo IS DISTINCT FROM true
                THEN NOW()
                ELSE updated_at
              END
            WHERE id = $10
            RETURNING
              (
                nombre IS DISTINCT FROM $11
                OR direccion IS DISTINCT FROM $12
                OR localidad IS DISTINCT FROM $13
                OR latitud IS DISTINCT FROM $14
                OR longitud IS DISTINCT FROM $15
                OR radio_geocerca IS DISTINCT FROM $16
                OR categoria IS DISTINCT FROM $17
                OR frecuencia_id IS DISTINCT FROM $18
                OR canal_id IS DISTINCT FROM $19
                OR ruta_id IS DISTINCT FROM $20
                OR activo IS DISTINCT FROM $21
              ) AS cambio
            `,
            [
              nombre,
              direccion,
              localidad,
              coords.latitud,
              coords.longitud,
              categoria,
              frecuenciaId,
              canalId,
              rutaId,
              c.id,

              c.nombre,
              c.direccion,
              c.localidad,
              c.latitud,
              c.longitud,
              c.radio_geocerca,
              c.categoria,
              c.frecuencia_id,
              c.canal_id,
              c.ruta_id,
              c.activo
            ]
          );

          if (result.rows[0]?.cambio) actualizados++;
          else sinCambios++;

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
            VALUES ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10,true)
            `,
            [
              codigoNormalizado,
              nombre,
              direccion,
              localidad,
              coords.latitud,
              coords.longitud,
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
        SET activo = false,
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
      sinCambios,
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