const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const db = require("../config/database");

const router = express.Router();

const LIMITE_FOTO_BYTES = 1_500_000;

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: LIMITE_FOTO_BYTES,
    files: 1
  },

  fileFilter: (req, file, callback) => {
    const tiposPermitidos = [
      "image/jpeg",
      "image/jpg"
    ];

    if (!tiposPermitidos.includes(file.mimetype)) {
      return callback(
        new Error("Solo se permiten fotografías JPG")
      );
    }

    callback(null, true);
  }
});

function valorONull(valor) {
  if (
    valor === undefined ||
    valor === null ||
    valor === "" ||
    valor === "null" ||
    valor === "undefined"
  ) {
    return null;
  }

  return String(valor);
}

function numeroONull(valor) {
  const numero = Number(valor);

  return Number.isFinite(numero)
    ? numero
    : null;
}

function fechaCaptura(valor) {
  if (!valor) {
    return new Date();
  }

  const numero = Number(valor);

  const fecha = Number.isFinite(numero)
    ? new Date(numero)
    : new Date(valor);

  if (Number.isNaN(fecha.getTime())) {
    return new Date();
  }

  return fecha;
}

function limpiarSegmento(valor, reemplazo) {
  return String(valor || reemplazo)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 100);
}

async function subirBufferCloudinary(buffer, opciones) {
  const cloudName =
    process.env.CLOUDINARY_CLOUD_NAME;

  const apiKey =
    process.env.CLOUDINARY_API_KEY;

  const apiSecret =
    process.env.CLOUDINARY_API_SECRET;

  if (
    !cloudName ||
    !apiKey ||
    !apiSecret
  ) {
    throw new Error(
      "Faltan credenciales de Cloudinary en las variables de entorno"
    );
  }

  const url =
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      cloudName
    )}/image/upload`;

  const auth =
    Buffer.from(
      `${apiKey}:${apiSecret}`,
      "utf8"
    ).toString("base64");

  const formulario =
    new FormData();

  const archivo =
    new Blob(
      [buffer],
      {
        type: "image/jpeg"
      }
    );

  formulario.append(
    "file",
    archivo,
    "evidencia.jpg"
  );

  if (opciones.folder) {
    formulario.append(
      "folder",
      opciones.folder
    );
  }

  if (opciones.public_id) {
    formulario.append(
      "public_id",
      opciones.public_id
    );
  }

  const respuesta =
    await fetch(
      url,
      {
        method: "POST",
        headers: {
          Authorization:
            `Basic ${auth}`
        },
        body: formulario
      }
    );

  const cuerpoTexto =
    await respuesta.text();

  let cuerpoJson;

  try {
    cuerpoJson =
      cuerpoTexto
        ? JSON.parse(cuerpoTexto)
        : {};
  } catch (_) {
    cuerpoJson = {
      raw: cuerpoTexto
    };
  }

  if (!respuesta.ok) {
    const detalle =
      cuerpoJson?.error?.message ||
      cuerpoJson?.message ||
      cuerpoTexto ||
      `HTTP ${respuesta.status}`;

    const error =
      new Error(
        `Cloudinary respondió ${respuesta.status}: ${detalle}`
      );

    error.http_code =
      respuesta.status;

    error.respuesta_cloudinary =
      cuerpoJson;

    throw error;
  }

  return cuerpoJson;
}

/*
POST /fotos/evidencias

multipart/form-data:

foto
id_evidencia
vendedor_id
cliente_id
visita_id
fecha_captura
latitud
longitud
precision_gps
peso_bytes
ancho
alto
tipo_foto
*/

router.post(
  "/evidencias",
  upload.single("foto"),
  async (req, res) => {
    const idEvidencia =
      valorONull(req.body.id_evidencia) ||
      crypto.randomUUID();

    const vendedorId =
      valorONull(req.body.vendedor_id);

    if (!vendedorId) {
      return res.status(400).json({
        error: "Falta vendedor_id"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Falta la fotografía"
      });
    }

    const clienteId =
      valorONull(req.body.cliente_id);

    const visitaId =
      valorONull(req.body.visita_id);

    const fecha =
      fechaCaptura(req.body.fecha_captura);

    const latitud =
      numeroONull(req.body.latitud);

    const longitud =
      numeroONull(req.body.longitud);

    const precisionGps =
      numeroONull(req.body.precision_gps);

    const ancho =
      numeroONull(req.body.ancho);

    const alto =
      numeroONull(req.body.alto);

    const tipoFoto =
      valorONull(req.body.tipo_foto) ||
      (
        visitaId
          ? "VISITA"
          : clienteId
            ? "CLIENTE"
            : "LIBRE"
      );

    let registroCreado = false;

    try {
      await db.query(
        `
        INSERT INTO fotos_evidencias (
          id,
          vendedor_id,
          cliente_id,
          visita_id,
          fecha_captura,
          latitud,
          longitud,
          precision_gps,
          peso_bytes,
          ancho,
          alto,
          tipo_foto,
          estado,
          created_at,
          updated_at
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
          'RECIBIDA',
          NOW(),
          NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          vendedor_id = EXCLUDED.vendedor_id,
          cliente_id = EXCLUDED.cliente_id,
          visita_id = EXCLUDED.visita_id,
          fecha_captura = EXCLUDED.fecha_captura,
          latitud = EXCLUDED.latitud,
          longitud = EXCLUDED.longitud,
          precision_gps = EXCLUDED.precision_gps,
          peso_bytes = EXCLUDED.peso_bytes,
          ancho = EXCLUDED.ancho,
          alto = EXCLUDED.alto,
          tipo_foto = EXCLUDED.tipo_foto,
          estado = 'RECIBIDA',
          error_mensaje = NULL,
          updated_at = NOW()
        `,
        [
          idEvidencia,
          vendedorId,
          clienteId,
          visitaId,
          fecha,
          latitud,
          longitud,
          precisionGps,
          req.file.size,
          ancho,
          alto,
          tipoFoto
        ]
      );

      registroCreado = true;

      const anio =
        String(fecha.getUTCFullYear());

      const mes =
        String(fecha.getUTCMonth() + 1)
          .padStart(2, "0");

      const carpetaDestino =
        visitaId
          ? `visita_${limpiarSegmento(visitaId, "sin_visita")}`
          : clienteId
            ? `cliente_${limpiarSegmento(clienteId, "sin_cliente")}`
            : "libres";

      const carpetaCloudinary = [
        "SEC",
        "evidencias",
        `vendedor_${limpiarSegmento(vendedorId, "desconocido")}`,
        anio,
        mes,
        carpetaDestino
      ].join("/");

      const resultadoCloudinary =
        await subirBufferCloudinary(
          req.file.buffer,
          {
            folder: carpetaCloudinary,

            public_id:
              `evidencia_${limpiarSegmento(
                idEvidencia,
                crypto.randomUUID()
              )}`,

            resource_type: "image"
          }
        );

      const resultadoDb = await db.query(
        `
        UPDATE fotos_evidencias
        SET
          cloudinary_public_id = $2,
          url_imagen = $3,
          url_segura = $4,
          formato = $5,
          cloudinary_bytes = $6,
          ancho_cloudinary = $7,
          alto_cloudinary = $8,
          estado = 'SINCRONIZADA',
          sincronizada_at = NOW(),
          updated_at = NOW(),
          error_mensaje = NULL
        WHERE id = $1
        RETURNING *
        `,
        [
          idEvidencia,
          resultadoCloudinary.public_id,
          resultadoCloudinary.url,
          resultadoCloudinary.secure_url,
          resultadoCloudinary.format,
          resultadoCloudinary.bytes,
          resultadoCloudinary.width,
          resultadoCloudinary.height
        ]
      );

      return res.status(201).json({
        ok: true,
        mensaje: "Fotografía sincronizada correctamente",
        evidencia: resultadoDb.rows[0]
      });

    } catch (error) {
      console.error(
        "ERROR SINCRONIZANDO FOTO:",
        error
      );

      if (registroCreado) {
        try {
          await db.query(
            `
            UPDATE fotos_evidencias
            SET
              estado = 'ERROR',
              error_mensaje = $2,
              updated_at = NOW()
            WHERE id = $1
            `,
            [
              idEvidencia,
              String(error.message || error)
                .slice(0, 1000)
            ]
          );
        } catch (errorDb) {
          console.error(
            "ERROR REGISTRANDO FALLO DE FOTO:",
            errorDb.message
          );
        }
      }

      return res.status(500).json({
        error: "No se pudo sincronizar la fotografía",
        detalle: error.message,
        id_evidencia: idEvidencia
      });
    }
  }
);

/*
LISTADO PARA LA BIBLIOTECA
GET /fotos/evidencias
*/

router.get(
  "/evidencias",
  async (req, res) => {
    try {
      const {
        vendedor_id,
        cliente_id,
        visita_id,
        estado,
        fecha_desde,
        fecha_hasta
      } = req.query;

      const condiciones = [];
      const valores = [];

      function agregarCondicion(sql, valor) {
        valores.push(valor);

        condiciones.push(
          sql.replace(
            "?",
            `$${valores.length}`
          )
        );
      }

      if (vendedor_id) {
        agregarCondicion(
          "vendedor_id = ?",
          vendedor_id
        );
      }

      if (cliente_id) {
        agregarCondicion(
          "cliente_id = ?",
          cliente_id
        );
      }

      if (visita_id) {
        agregarCondicion(
          "visita_id = ?",
          visita_id
        );
      }

      if (estado) {
        agregarCondicion(
          "estado = ?",
          estado
        );
      }

      if (fecha_desde) {
        agregarCondicion(
          "fecha_captura >= ?",
          fecha_desde
        );
      }

      if (fecha_hasta) {
        agregarCondicion(
          "fecha_captura < (?::date + INTERVAL '1 day')",
          fecha_hasta
        );
      }

      const where =
        condiciones.length > 0
          ? `WHERE ${condiciones.join(" AND ")}`
          : "";

      const resultado = await db.query(
        `
        SELECT *
        FROM fotos_evidencias
        ${where}
        ORDER BY
          fecha_captura DESC,
          created_at DESC
        LIMIT 500
        `,
        valores
      );

      res.json(resultado.rows);

    } catch (error) {
      console.error(
        "ERROR LISTANDO FOTOS:",
        error
      );

      res.status(500).json({
        error: "No se pudieron obtener las fotografías",
        detalle: error.message
      });
    }
  }
);

router.use(
  (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error:
            "La fotografía supera el máximo permitido de 1,5 MB"
        });
      }

      return res.status(400).json({
        error: "Error recibiendo la fotografía",
        detalle: error.message
      });
    }

    if (error) {
      return res.status(400).json({
        error: error.message
      });
    }

    next();
  }
);

module.exports = router;