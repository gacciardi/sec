const express = require("express");
const db = require("../config/database");

const router = express.Router();

const RADIO_DEFAULT_METROS = 30;
const MAX_INTERVALO_GPS_SEGUNDOS = 75;

// ======================================================
// FUNCIONES AUXILIARES
// ======================================================

function numeroValido(valor) {
  const numero = Number(valor);

  if (!Number.isFinite(numero)) {
    return null;
  }

  return numero;
}

function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const rad = (grados) =>
    (grados * Math.PI) / 180;

  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

function nombreDia(fecha) {
  const partes = String(fecha)
    .split("-")
    .map(Number);

  if (partes.length !== 3) {
    return null;
  }

  const [anio, mes, dia] = partes;

  const fechaUtc = new Date(
    Date.UTC(anio, mes - 1, dia)
  );

  const dias = [
    "domingo",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "sabado"
  ];

  return dias[fechaUtc.getUTCDay()];
}

function semanaDelMes(fecha) {
  const partes = String(fecha)
    .split("-")
    .map(Number);

  if (partes.length !== 3) {
    return null;
  }

  const dia = partes[2];

  if (!Number.isInteger(dia)) {
    return null;
  }

  return Math.floor((dia - 1) / 7) + 1;
}

function diferenciaSegundos(fecha1, fecha2) {
  const a = new Date(fecha1).getTime();
  const b = new Date(fecha2).getTime();

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.round((b - a) / 1000)
  );
}

function analizarPermanenciaGps(
  puntos,
  radioGeocerca
) {
  const puntosDentro = [];
  const tramos = [];

  let tramoActual = null;
  let puntoAnteriorDentro = null;

  for (const punto of puntos) {
    const estaDentro =
      punto.distancia_metros !== null &&
      punto.distancia_metros <= radioGeocerca;

    if (!estaDentro) {
      if (tramoActual) {
        tramos.push(tramoActual);
        tramoActual = null;
      }

      puntoAnteriorDentro = null;
      continue;
    }

    puntosDentro.push(punto);

    if (!tramoActual) {
      tramoActual = {
        inicio: punto.fecha_hora,
        fin: punto.fecha_hora,
        puntos: 1,
        permanencia_segundos: 0
      };

      puntoAnteriorDentro = punto;
      continue;
    }

    const intervalo =
      diferenciaSegundos(
        puntoAnteriorDentro.fecha_hora,
        punto.fecha_hora
      );

    if (
      intervalo !== null &&
      intervalo <= MAX_INTERVALO_GPS_SEGUNDOS
    ) {
      tramoActual.fin = punto.fecha_hora;
      tramoActual.puntos += 1;
      tramoActual.permanencia_segundos +=
        intervalo;
    } else {
      tramos.push(tramoActual);

      tramoActual = {
        inicio: punto.fecha_hora,
        fin: punto.fecha_hora,
        puntos: 1,
        permanencia_segundos: 0
      };
    }

    puntoAnteriorDentro = punto;
  }

  if (tramoActual) {
    tramos.push(tramoActual);
  }

  if (puntosDentro.length === 0) {
    return {
      entro_geocerca: false,
      cantidad_puntos_dentro: 0,
      cantidad_tramos: 0,
      primera_entrada: null,
      ultima_posicion_dentro: null,
      permanencia_estimada_segundos: 0,
      tramos: []
    };
  }

  const permanenciaTotal =
    tramos.reduce(
      (acumulado, tramo) =>
        acumulado +
        tramo.permanencia_segundos,
      0
    );

  return {
    entro_geocerca: true,

    cantidad_puntos_dentro:
      puntosDentro.length,

    cantidad_tramos:
      tramos.length,

    primera_entrada:
      puntosDentro[0].fecha_hora,

    ultima_posicion_dentro:
      puntosDentro[
        puntosDentro.length - 1
      ].fecha_hora,

    permanencia_estimada_segundos:
      permanenciaTotal,

    tramos
  };
}
// ======================================================
// GET /auditoria/analizar
//
// Parámetros:
// vendedor_id
// cliente_id
// fecha = YYYY-MM-DD
//
// RUTA EXCLUSIVAMENTE DE CONSULTA
// ======================================================

router.get("/analizar", async (req, res) => {
  try {
    const {
      vendedor_id,
      cliente_id,
      fecha
    } = req.query;

    if (
      !vendedor_id ||
      !cliente_id ||
      !fecha
    ) {
      return res.status(400).json({
        error:
          "Debe indicar vendedor_id, cliente_id y fecha"
      });
    }

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        String(fecha)
      )
    ) {
      return res.status(400).json({
        error:
          "La fecha debe tener formato YYYY-MM-DD"
      });
    }

    const diaSemana = nombreDia(fecha);
    const semanaMes = semanaDelMes(fecha);

    // ==================================================
    // VENDEDOR
    // ==================================================

    const vendedorResult =
      await db.query(
        `
        SELECT
          id,
          nombre,
          apellido,
          legajo,
          activo
        FROM usuarios
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
        `,
        [vendedor_id]
      );

    if (
      vendedorResult.rows.length === 0
    ) {
      return res.status(404).json({
        error: "Vendedor no encontrado"
      });
    }

    const vendedor =
      vendedorResult.rows[0];

    // ==================================================
    // CLIENTE
    // ==================================================

    const clienteResult =
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
          COALESCE(
            c.radio_geocerca,
            $2
          ) AS radio_geocerca,
          c.es_ejecucion,
          c.semana_ejecucion,
          c.activo
        FROM clientes c
        WHERE c.id = $1
          AND c.deleted_at IS NULL
        LIMIT 1
        `,
        [
          cliente_id,
          RADIO_DEFAULT_METROS
        ]
      );

    if (
      clienteResult.rows.length === 0
    ) {
      return res.status(404).json({
        error: "Cliente no encontrado"
      });
    }

    const cliente =
      clienteResult.rows[0];

    const latCliente =
      numeroValido(cliente.latitud);

    const lonCliente =
      numeroValido(cliente.longitud);

    const radioGeocerca =
      numeroValido(
        cliente.radio_geocerca
      ) || RADIO_DEFAULT_METROS;

    // ==================================================
    // ASIGNACIONES
    //
    // Se consideran:
    // - asignaciones activas
    // - modalidad activa
    // - modalidad APK o cliente Ejecución
    // - vendedor directo
    // - vendedor efectivo de ruta
    // - reemplazo vigente para la fecha consultada
    // ==================================================

    const asignacionesResult =
      await db.query(
        `
        SELECT
          a.id AS asignacion_id,
          a.modalidad,
          a.ruta_id,
          a.vendedor_id
            AS vendedor_directo_id,
          a.frecuencia_id,

          ma.descripcion
            AS modalidad_nombre,
          ma.enviar_apk,

          r.nombre AS ruta,
          r.tipo_atencion,
          r.vendedor_id
            AS vendedor_titular_ruta_id,

          rr.vendedor_reemplazo_id,

          COALESCE(
            rr.vendedor_reemplazo_id,
            r.vendedor_id,
            a.vendedor_id
          ) AS vendedor_efectivo_id,

          f.nombre AS frecuencia,
          f.lunes,
          f.martes,
          f.miercoles,
          f.jueves,
          f.viernes,
          f.sabado

        FROM clientes_asignaciones a

        INNER JOIN modalidades_atencion ma
          ON ma.codigo = a.modalidad
         AND ma.activo = true

        LEFT JOIN rutas r
          ON r.id = a.ruta_id
         AND r.activo = true

        LEFT JOIN frecuencias f
          ON f.id = a.frecuencia_id
         AND f.deleted_at IS NULL

        LEFT JOIN LATERAL (
          SELECT
            rep.vendedor_reemplazo_id
          FROM reemplazos_ruta rep
          WHERE rep.ruta_id = a.ruta_id
            AND rep.activo = true
            AND $3::date
                BETWEEN rep.fecha_desde
                    AND rep.fecha_hasta
          ORDER BY
            rep.created_at DESC
          LIMIT 1
        ) rr
          ON true

        WHERE a.cliente_id = $1
          AND a.activo = true

          AND (
            ma.enviar_apk = true
            OR $4::boolean = true
          )

          AND COALESCE(
            rr.vendedor_reemplazo_id,
            r.vendedor_id,
            a.vendedor_id
          ) = $2

        ORDER BY
          a.updated_at DESC,
          a.created_at DESC
        `,
        [
          cliente_id,
          vendedor_id,
          fecha,
          cliente.es_ejecucion === true
        ]
      );

    const asignaciones =
      asignacionesResult.rows;

    // ==================================================
    // PROGRAMACIÓN DEL DÍA
    // ==================================================

    let programadoPorFrecuencia = false;

    for (const asignacion of asignaciones) {
      if (
        diaSemana &&
        Object.prototype.hasOwnProperty.call(
          asignacion,
          diaSemana
        )
      ) {
        if (
          asignacion[diaSemana] === true
        ) {
          programadoPorFrecuencia = true;
        }
      }
    }

    const esEjecucion =
      cliente.es_ejecucion === true;

    const semanaEjecucion =
      cliente.semana_ejecucion !== null &&
      cliente.semana_ejecucion !== undefined
        ? Number(
            cliente.semana_ejecucion
          )
        : null;

    const ejecucionCorrespondeSemana =
      !esEjecucion ||
      semanaEjecucion === null
        ? true
        : semanaEjecucion === semanaMes;

    const programado =
      asignaciones.length > 0 &&
      programadoPorFrecuencia &&
      ejecucionCorrespondeSemana;

    // ==================================================
    // GPS DEL VENDEDOR PARA LA FECHA
    //
    // Se conserva el mismo criterio de fecha utilizado
    // por el endpoint histórico de GPS existente.
    // ==================================================

    const gpsResult =
      await db.query(
        `
        SELECT
          id,
          latitud,
          longitud,
          precision_metros,
          velocidad,
          fecha_hora
        FROM gps_logs
        WHERE vendedor_id = $1
          AND fecha_hora >= $2::date
          AND fecha_hora <
              ($2::date + INTERVAL '1 day')
          AND latitud IS NOT NULL
          AND longitud IS NOT NULL
          AND latitud <> 0
          AND longitud <> 0
        ORDER BY fecha_hora ASC
        `,
        [
          vendedor_id,
          fecha
        ]
      );

    let puntosGps = [];

    if (
      latCliente !== null &&
      lonCliente !== null
    ) {
      puntosGps =
        gpsResult.rows.map((punto) => {
          const lat =
            numeroValido(
              punto.latitud
            );

          const lon =
            numeroValido(
              punto.longitud
            );

          let distancia = null;

          if (
            lat !== null &&
            lon !== null
          ) {
            distancia =
              haversineMetros(
                lat,
                lon,
                latCliente,
                lonCliente
              );
          }

          return {
            id: punto.id,
            latitud: lat,
            longitud: lon,

            precision_metros:
              numeroValido(
                punto.precision_metros
              ),

            velocidad:
              numeroValido(
                punto.velocidad
              ),

            fecha_hora:
              punto.fecha_hora,

            distancia_metros:
              distancia === null
                ? null
                : Math.round(
                    distancia * 10
                  ) / 10,

            dentro_geocerca:
              distancia !== null &&
              distancia <=
                radioGeocerca
          };
        });
    } else {
      puntosGps =
        gpsResult.rows.map((punto) => ({
          id: punto.id,

          latitud:
            numeroValido(
              punto.latitud
            ),

          longitud:
            numeroValido(
              punto.longitud
            ),

          precision_metros:
            numeroValido(
              punto.precision_metros
            ),

          velocidad:
            numeroValido(
              punto.velocidad
            ),

          fecha_hora:
            punto.fecha_hora,

          distancia_metros: null,
          dentro_geocerca: null
        }));
    }

    let puntoMasCercano = null;

    for (const punto of puntosGps) {
      if (
        punto.distancia_metros === null
      ) {
        continue;
      }

      if (
        !puntoMasCercano ||
        punto.distancia_metros <
          puntoMasCercano.distancia_metros
      ) {
        puntoMasCercano = punto;
      }
    }

    const permanenciaGps =
      analizarPermanenciaGps(
        puntosGps,
        radioGeocerca
      );

    // ==================================================
    // VISITAS SEC
    // ==================================================

    const visitasResult =
      await db.query(
        `
        SELECT
          id,
          fecha,
          hora_llegada,
          hora_salida,
          permanencia_segundos,
          dentro_geocerca,
          latitud_llegada,
          longitud_llegada,
          latitud_salida,
          longitud_salida,
          observaciones,
          created_at
        FROM visitas
        WHERE vendedor_id = $1
          AND cliente_id = $2
          AND fecha = $3::date
        ORDER BY
          hora_llegada ASC NULLS LAST,
          created_at ASC
        `,
        [
          vendedor_id,
          cliente_id,
          fecha
        ]
      );

    const visitas =
      visitasResult.rows;

    let primeraLlegada = null;
    let ultimaSalida = null;
    let permanenciaSecSegundos = 0;
    let algunaDentroGeocerca = false;
    let visitaAbierta = false;

    for (const visita of visitas) {
      if (
        visita.hora_llegada &&
        (
          !primeraLlegada ||
          new Date(
            visita.hora_llegada
          ) <
          new Date(
            primeraLlegada
          )
        )
      ) {
        primeraLlegada =
          visita.hora_llegada;
      }

      if (visita.hora_salida) {
        if (
          !ultimaSalida ||
          new Date(
            visita.hora_salida
          ) >
          new Date(
            ultimaSalida
          )
        ) {
          ultimaSalida =
            visita.hora_salida;
        }
      } else {
        visitaAbierta = true;
      }

      const permanencia =
        numeroValido(
          visita.permanencia_segundos
        );

      if (
        permanencia !== null &&
        permanencia > 0
      ) {
        permanenciaSecSegundos +=
          permanencia;
      }

      if (
        visita.dentro_geocerca === true
      ) {
        algunaDentroGeocerca = true;
      }
    }

    // ==================================================
    // DIAGNÓSTICO
    // ==================================================

    let codigoDiagnostico;
    let diagnostico;

    if (
      latCliente === null ||
      lonCliente === null
    ) {
      codigoDiagnostico =
        "CLIENTE_SIN_COORDENADAS";

      diagnostico =
        "El cliente no tiene coordenadas válidas. No es posible evaluar la geocerca.";
    } else if (
      puntosGps.length === 0
    ) {
      codigoDiagnostico =
        "SIN_GPS";

      diagnostico =
        "No se encontraron posiciones GPS del vendedor para la fecha seleccionada.";
    } else if (
      permanenciaGps.entro_geocerca &&
      visitas.length > 0
    ) {
      codigoDiagnostico =
        "GPS_Y_VISITA";

      diagnostico =
        "Se detectaron posiciones GPS dentro de la geocerca y SEC registra visita al cliente.";
    } else if (
      permanenciaGps.entro_geocerca &&
      visitas.length === 0
    ) {
      codigoDiagnostico =
        "GPS_SIN_VISITA";

      diagnostico =
        "Se detectaron posiciones GPS dentro de la geocerca, pero SEC no registra una visita al cliente para la fecha seleccionada.";
    } else if (
      !permanenciaGps.entro_geocerca &&
      visitas.length > 0
    ) {
      codigoDiagnostico =
        "VISITA_SIN_GPS_EN_GEOCERCA";

      diagnostico =
        "SEC registra una visita, pero los puntos GPS disponibles del período no muestran posiciones dentro de la geocerca.";
    } else {
      codigoDiagnostico =
        "SIN_ENTRADA_GEOCERCA";

      diagnostico =
        "No se detectaron posiciones GPS dentro de la geocerca y SEC no registra una visita al cliente.";
    }

    // ==================================================
    // RESPUESTA
    // ==================================================

    res.json({
      consulta: {
        fecha,
        dia_semana: diaSemana,
        semana_mes: semanaMes
      },

      vendedor: {
        id: vendedor.id,
        nombre: vendedor.nombre,
        apellido: vendedor.apellido,
        legajo: vendedor.legajo,
        activo: vendedor.activo
      },

      cliente: {
        id: cliente.id,

        codigo_cliente:
          cliente.codigo_cliente,

        nombre: cliente.nombre,
        direccion: cliente.direccion,
        localidad: cliente.localidad,

        latitud: latCliente,
        longitud: lonCliente,

        radio_geocerca:
          radioGeocerca,

        es_ejecucion:
          esEjecucion,

        semana_ejecucion:
          semanaEjecucion,

        activo: cliente.activo
      },

      programacion: {
        asignado_al_vendedor:
          asignaciones.length > 0,

        programado_por_frecuencia:
          programadoPorFrecuencia,

        ejecucion_corresponde_semana:
          ejecucionCorrespondeSemana,

        programado,

        asignaciones
      },

      gps: {
        cantidad_puntos:
          puntosGps.length,

        punto_mas_cercano:
          puntoMasCercano,

        entro_geocerca:
          permanenciaGps.entro_geocerca,

        primera_entrada:
          permanenciaGps.primera_entrada,

        ultima_posicion_dentro:
          permanenciaGps
            .ultima_posicion_dentro,

        cantidad_puntos_dentro:
          permanenciaGps
            .cantidad_puntos_dentro,

        cantidad_tramos:
          permanenciaGps
            .cantidad_tramos,

        permanencia_estimada_segundos:
          permanenciaGps
            .permanencia_estimada_segundos,

        criterio_continuidad_segundos:
          MAX_INTERVALO_GPS_SEGUNDOS,

        tramos:
          permanenciaGps.tramos,

        puntos:
          puntosGps
      },

      visita_sec: {
        existe:
          visitas.length > 0,

        cantidad_registros:
          visitas.length,

        primera_llegada:
          primeraLlegada,

        ultima_salida:
          ultimaSalida,

        permanencia_registrada_segundos:
          permanenciaSecSegundos,

        dentro_geocerca:
          algunaDentroGeocerca,

        visita_abierta:
          visitaAbierta,

        registros:
          visitas
      },

      diagnostico: {
        codigo:
          codigoDiagnostico,

        mensaje:
          diagnostico
      }
    });
  } catch (error) {
    console.error(
      "Error en auditoría:",
      error
    );

    res.status(500).json({
      error:
        "Error al realizar la auditoría",

      detalle:
        error.message
    });
  }
});

module.exports = router;
