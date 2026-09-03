const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const db = require("../config/database");

const router = express.Router();

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

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

function valorCampoMultiple(fila, nombres) {
  for (const nombre of nombres) {
    const valor = valorCampo(fila, nombre);

    if (
      valor !== null &&
      valor !== undefined &&
      String(valor).trim() !== ""
    ) {
      return valor;
    }
  }

  return null;
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
    .replace(/[.,;:()[\]{}"'`´]/g, " ")
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

function normalizarModalidad(valor) {
  const modalidad = limpiarTexto(valor);

  if (!modalidad) {
    return null;
  }

  const codigo = modalidad
    .toUpperCase()
    .replace(/\s+/g, "");

  return ["PR", "TA", "WA", "FC", "FW"].includes(codigo)
    ? codigo
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

  /*
  Algunos maestros traen coordenadas sin el punto
  decimal. Ejemplos:

  -347760188  -> -34.7760188
  -58610785   -> -58.610785

  Recuperamos esos valores antes de validar o invertir
  latitud y longitud.
  */
  function recuperarDecimalCoordenada(valor) {
    if (
      valor === null ||
      !Number.isFinite(valor) ||
      valor === 0
    ) {
      return valor;
    }

    let corregido = valor;

    while (Math.abs(corregido) > 180) {
      corregido = corregido / 10;
    }

    return corregido;
  }

  latitud =
    recuperarDecimalCoordenada(latitud);

  longitud =
    recuperarDecimalCoordenada(longitud);

  /*
  Conservamos la corrección de columnas invertidas
  que ya utilizaba SEC.
  */
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

  /*
  0 / 0 significa que el maestro no tiene una
  geolocalización útil para ese cliente.
  */
  if (latitud === 0) {
    latitud = null;
  }

  if (longitud === 0) {
    longitud = null;
  }

  /*
  Validación final de rangos GPS.
  */
  if (
    latitud !== null &&
    (latitud < -90 || latitud > 90)
  ) {
    latitud = null;
  }

  if (
    longitud !== null &&
    (longitud < -180 || longitud > 180)
  ) {
    longitud = null;
  }

  return {
    latitud,
    longitud,
    invertidas
  };
}

function tokensNombre(valor) {
  const normalizado =
    normalizarTextoComparacion(valor);

  if (!normalizado) {
    return [];
  }

  return normalizado
    .split(" ")
    .filter(Boolean);
}

function todosLosTokensEstan(
  tokensBuscados,
  tokensCandidato
) {
  if (
    tokensBuscados.length === 0 ||
    tokensCandidato.length === 0
  ) {
    return false;
  }

  return tokensBuscados.every(
    token =>
      tokensCandidato.includes(token)
  );
}

function nombresCompatibles(
  nombreExcel,
  nombreUsuario
) {
  const excel =
    normalizarTextoComparacion(
      nombreExcel
    );

  const usuario =
    normalizarTextoComparacion(
      nombreUsuario
    );

  if (!excel || !usuario) {
    return false;
  }

  if (excel === usuario) {
    return true;
  }

  const tokensExcel =
    tokensNombre(excel);

  const tokensUsuario =
    tokensNombre(usuario);

  /*
  Permite casos seguros como:
  "ROCIO URANGA"
  contra
  "ROCIO URANGA DEL CAMPO"

  También funciona aunque el orden sea:
  "URANGA ROCIO"
  */
  return (
    todosLosTokensEstan(
      tokensExcel,
      tokensUsuario
    ) ||
    todosLosTokensEstan(
      tokensUsuario,
      tokensExcel
    )
  );
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

  /*
  Primero intentamos coincidencia exacta ignorando
  mayúsculas/minúsculas y espacios exteriores.
  */
  const exacto = await db.query(
    `
    SELECT id, nombre
    FROM canales
    WHERE deleted_at IS NULL
      AND UPPER(TRIM(nombre)) =
          UPPER(TRIM($1))
    LIMIT 1
    `,
    [nombre]
  );

  if (exacto.rows.length > 0) {
    return exacto.rows[0].id;
  }

  /*
  Si el nombre del Excel no coincide exactamente,
  hacemos una segunda búsqueda normalizada.

  Esto permite resolver diferencias habituales como:
  - mayúsculas/minúsculas
  - tildes
  - puntos, comas o paréntesis
  - espacios dobles
  */
  const canalesResult = await db.query(
    `
    SELECT id, nombre
    FROM canales
    WHERE deleted_at IS NULL
    ORDER BY nombre
    `
  );

  const canalBuscado =
    normalizarTextoComparacion(nombre);

  if (!canalBuscado) {
    return null;
  }

  const coincidencias =
    canalesResult.rows.filter(
      canal =>
        normalizarTextoComparacion(
          canal.nombre
        ) === canalBuscado
    );

  /*
  Solo asignamos automáticamente cuando existe
  una única coincidencia. Si hubiera más de una,
  preferimos no adivinar.
  */
  return coincidencias.length === 1
    ? coincidencias[0].id
    : null;
}

async function obtenerOCrearRuta(valor) {
  const rutaNombre =
    normalizarCodigo(valor);

  if (!rutaNombre) {
    return {
      rutaId: null,
      creada: false,
      nombre: null,
      vendedorIdActual: null
    };
  }

  let result = await db.query(
    `
    SELECT
      id,
      nombre,
      vendedor_id,
      activo
    FROM rutas
    WHERE UPPER(TRIM(nombre)) =
          UPPER(TRIM($1))
    LIMIT 1
    `,
    [rutaNombre]
  );

  if (result.rows.length > 0) {
    /*
    Si la ruta aparece en el maestro actual,
    se considera una ruta vigente.
    */
    if (result.rows[0].activo === false) {
      await db.query(
        `
        UPDATE rutas
        SET
          activo = true,
          updated_at = NOW()
        WHERE id = $1
        `,
        [result.rows[0].id]
      );
    }

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

  return result.rows.map(
    vendedor => {
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

        apellido_nombre:
          apellidoNombre,

        clave_nombre:
          normalizarTextoComparacion(
            nombreCompleto
          ),

        clave_apellido_nombre:
          normalizarTextoComparacion(
            apellidoNombre
          ),

        legajo_normalizado:
          normalizarCodigo(
            vendedor.legajo
          )
      };
    }
  );
}

function buscarVendedor(
  vendedores,
  fila
) {
  /*
  Si en algún momento el maestro incorpora
  legajo, esta búsqueda tiene prioridad porque
  es inequívoca.
  */
  const legajoExcel =
    normalizarCodigo(
      valorCampoMultiple(
        fila,
        [
          "legajo",
          "legajo_vendedor",
          "vendedor_legajo",
          "legajo vendedor"
        ]
      )
    );

  if (legajoExcel) {
    const porLegajo =
      vendedores.filter(
        vendedor =>
          vendedor.legajo_normalizado ===
          legajoExcel
      );

    if (porLegajo.length === 1) {
      return {
        vendedor: porLegajo[0],
        metodo: "LEGAJO",
        valorBuscado: legajoExcel,
        coincidencias: porLegajo
      };
    }

    if (porLegajo.length > 1) {
      return {
        vendedor: null,
        metodo: "LEGAJO_AMBIGUO",
        valorBuscado: legajoExcel,
        coincidencias: porLegajo
      };
    }
  }

  const nombreExcel =
    limpiarTexto(
      valorCampoMultiple(
        fila,
        [
          "vendedor",
          "vendedor_nombre",
          "nombre_vendedor",
          "vendedor nombre"
        ]
      )
    );

  if (!nombreExcel) {
    return {
      vendedor: null,
      metodo: "SIN_DATO",
      valorBuscado: null,
      coincidencias: []
    };
  }

  const clave =
    normalizarTextoComparacion(
      nombreExcel
    );

  /*
  1. Coincidencia exacta:
  Nombre Apellido
  o
  Apellido Nombre
  */
  const exactas =
    vendedores.filter(
      vendedor =>
        vendedor.clave_nombre === clave ||
        vendedor.clave_apellido_nombre === clave
    );

  if (exactas.length === 1) {
    return {
      vendedor: exactas[0],
      metodo: "NOMBRE_EXACTO",
      valorBuscado: nombreExcel,
      coincidencias: exactas
    };
  }

  if (exactas.length > 1) {
    return {
      vendedor: null,
      metodo: "NOMBRE_EXACTO_AMBIGUO",
      valorBuscado: nombreExcel,
      coincidencias: exactas
    };
  }

  /*
  2. Coincidencia flexible, pero segura:
  todos los tokens de uno deben estar incluidos
  en el otro.

  Ejemplo:
  Excel: "Rocio Uranga"
  Usuario: "Rocio Uranga del Campo"
  */
  const flexibles =
    vendedores.filter(
      vendedor =>
        nombresCompatibles(
          nombreExcel,
          vendedor.nombre_completo
        ) ||
        nombresCompatibles(
          nombreExcel,
          vendedor.apellido_nombre
        )
    );

  if (flexibles.length === 1) {
    return {
      vendedor: flexibles[0],
      metodo: "NOMBRE_FLEXIBLE",
      valorBuscado: nombreExcel,
      coincidencias: flexibles
    };
  }

  return {
    vendedor: null,
    metodo:
      flexibles.length > 1
        ? "NOMBRE_FLEXIBLE_AMBIGUO"
        : "NO_ENCONTRADO",
    valorBuscado: nombreExcel,
    coincidencias: flexibles
  };
}

async function guardarAsignacionCliente({
  clienteId,
  modalidad,
  rutaId,
  vendedorId,
  frecuenciaId
}) {
  if (!clienteId || !modalidad) {
    return {
      creada: false,
      existente: false
    };
  }

  const existente = await db.query(
    `
    SELECT id
    FROM clientes_asignaciones
    WHERE cliente_id = $1
      AND modalidad = $2
      AND ruta_id IS NOT DISTINCT FROM $3::uuid
      AND vendedor_id IS NOT DISTINCT FROM $4::uuid
      AND frecuencia_id IS NOT DISTINCT FROM $5::uuid
    LIMIT 1
    `,
    [
      clienteId,
      modalidad,
      rutaId,
      vendedorId,
      frecuenciaId
    ]
  );

  if (existente.rows.length > 0) {
    await db.query(
      `
      UPDATE clientes_asignaciones
      SET
        activo = true,
        updated_at = NOW()
      WHERE id = $1
      `,
      [existente.rows[0].id]
    );

    return {
      creada: false,
      existente: true
    };
  }

  await db.query(
    `
    INSERT INTO clientes_asignaciones (
      cliente_id,
      modalidad,
      ruta_id,
      vendedor_id,
      frecuencia_id,
      activo
    )
    VALUES ($1, $2, $3, $4, $5, true)
    `,
    [
      clienteId,
      modalidad,
      rutaId,
      vendedorId,
      frecuenciaId
    ]
  );

  return {
    creada: true,
    existente: false
  };
}

function agregarCandidatoRuta(
  mapa,
  rutaResultado,
  vendedorResultado,
  codigoCliente
) {
  if (!rutaResultado.rutaId) {
    return;
  }

  if (
    !mapa.has(
      rutaResultado.rutaId
    )
  ) {
    mapa.set(
      rutaResultado.rutaId,
      {
        rutaId:
          rutaResultado.rutaId,

        ruta:
          rutaResultado.nombre,

        vendedorIdAnterior:
          rutaResultado.vendedorIdActual,

        vendedoresIds:
          new Set(),

        vendedoresExcel:
          new Set(),

        vendedoresResueltos:
          new Map(),

        clientes:
          0,

        clientesConVendedor:
          0,

        clientesSinVendedor:
          0,

        ejemplosClientes:
          []
      }
    );
  }

  const registro =
    mapa.get(
      rutaResultado.rutaId
    );

  registro.clientes++;

  if (
    registro.ejemplosClientes.length < 5
  ) {
    registro.ejemplosClientes.push(
      codigoCliente
    );
  }

  if (
    vendedorResultado.valorBuscado
  ) {
    registro.vendedoresExcel.add(
      vendedorResultado.valorBuscado
    );
  }

  if (vendedorResultado.vendedor) {
    registro.clientesConVendedor++;

    registro.vendedoresIds.add(
      vendedorResultado.vendedor.id
    );

    registro.vendedoresResueltos.set(
      vendedorResultado.vendedor.id,
      vendedorResultado.vendedor.nombre_completo
    );
  } else {
    registro.clientesSinVendedor++;
  }
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
    let archivoTemporal = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "No se recibió archivo Excel"
        });
      }

      archivoTemporal =
        req.file.path;

      const workbook =
        XLSX.readFile(
          req.file.path
        );

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

      if (filas.length === 0) {
        return res.status(400).json({
          error:
            "El archivo Excel no contiene filas para importar"
        });
      }

      const primeraFila =
        filas[0];

      const tieneCodigoCliente =
        Object.keys(
          primeraFila
        ).some(
          clave =>
            String(clave)
              .trim()
              .toLowerCase() ===
            "codigo_cliente"
        );

      if (!tieneCodigoCliente) {
        return res.status(400).json({
          error:
            'El Excel debe contener la columna "codigo_cliente"'
        });
      }

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
      let rutasSinCambio = 0;
      let rutasConConflicto = 0;
      let rutasSinVendedorExcel = 0;

      let clientesAsignadosDirectamente = 0;

      let asignacionesCreadas = 0;
      let asignacionesExistentes = 0;
      let filasSinModalidad = 0;
      let modalidadesNoReconocidas = 0;

      let sinCoordenadas = 0;
      let coordenadasInvertidas = 0;

      let vendedoresExactos = 0;
      let vendedoresFlexibles = 0;
      let vendedoresPorLegajo = 0;
      let vendedoresNoEncontrados = 0;
      let vendedoresAmbiguos = 0;

      const errores = [];
      const advertencias = [];
      const codigosImportados = [];

      const vendedoresEncontrados =
        new Set();

      /*
      Acumulamos la relación Ruta -> Vendedor
      durante toda la lectura y recién al final
      actualizamos la tabla rutas.

      Esto evita que "gane el primero" si el Excel
      tiene una inconsistencia.
      */
      const auditoriaRutas =
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

          const modalidadExcel =
            valorCampoMultiple(
              fila,
              [
                "modalidad",
                "modo",
                "tipo_modalidad",
                "tipo modalidad"
              ]
            );

          const modalidad =
            normalizarModalidad(
              modalidadExcel
            );

          if (!limpiarTexto(modalidadExcel)) {
            filasSinModalidad++;
          } else if (!modalidad) {
            modalidadesNoReconocidas++;

            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              modalidad:
                limpiarTexto(modalidadExcel),
              motivo:
                `Modalidad no reconocida: ` +
                `${limpiarTexto(modalidadExcel)}. ` +
                `Se importó el cliente, pero no se creó la asignación comercial.`
            });
          }

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
            limpiarTexto(
              frecuenciaExcel
            ) &&
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
            limpiarTexto(
              canalExcel
            ) &&
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

          const vendedorResultado =
            buscarVendedor(
              vendedores,
              fila
            );

          const vendedor =
            vendedorResultado.vendedor;

          if (vendedor) {
            vendedoresEncontrados.add(
              vendedor.id
            );

            if (
              vendedorResultado.metodo ===
              "LEGAJO"
            ) {
              vendedoresPorLegajo++;
            }

            if (
              vendedorResultado.metodo ===
              "NOMBRE_EXACTO"
            ) {
              vendedoresExactos++;
            }

            if (
              vendedorResultado.metodo ===
              "NOMBRE_FLEXIBLE"
            ) {
              vendedoresFlexibles++;
            }

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
          } else if (
            vendedorResultado.valorBuscado
          ) {
            const ambiguo =
              vendedorResultado.metodo
                .includes("AMBIGUO");

            if (ambiguo) {
              vendedoresAmbiguos++;
            } else {
              vendedoresNoEncontrados++;
            }

            advertencias.push({
              fila: numeroFila,
              codigo_cliente:
                codigoCliente,
              vendedor:
                vendedorResultado.valorBuscado,
              coincidencias:
                vendedorResultado
                  .coincidencias
                  .map(v =>
                    v.nombre_completo
                  ),
              metodo:
                vendedorResultado.metodo,
              motivo:
                ambiguo
                  ? `El vendedor "${vendedorResultado.valorBuscado}" ` +
                    `coincide con más de un usuario. No se asignó automáticamente.`
                  : `No se encontró el vendedor ` +
                    `"${vendedorResultado.valorBuscado}" en Usuarios`
            });
          }

          /*
          Registramos la relación que trae el Excel
          para auditarla al final.
          */
          agregarCandidatoRuta(
            auditoriaRutas,
            rutaResultado,
            vendedorResultado,
            codigoCliente
          );

          /*
          =============================
          BUSCAR CLIENTE EXISTENTE
          =============================
          */

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
          Si hay ruta, el vendedor efectivo se obtiene
          desde la ruta.

          Solo si NO hay ruta se guarda vendedor directo
          en clientes.vendedor_id.
          */
          const vendedorDirecto =
            !rutaId &&
            vendedor
              ? vendedor.id
              : null;

          let clienteIdProcesado = null;

          if (
            existente.rows.length > 0
          ) {
            const clienteActual =
              existente.rows[0];

            clienteIdProcesado =
              clienteActual.id;

            if (
              clienteActual.activo === false
            ) {
              reactivados++;
            }

            if (
              vendedorDirecto &&
              clienteActual.vendedor_id !==
                vendedorDirecto
            ) {
              clientesAsignadosDirectamente++;
            }

            /*
            Las coordenadas corregidas manualmente
            desde SEC tienen prioridad.
            */
            const latitudActual =
              normalizarNumero(
                clienteActual.latitud
              );

            const longitudActual =
              normalizarNumero(
                clienteActual.longitud
              );

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

              /*
              Si el Excel trae ruta, manda el Excel.
              Si no trae ruta, conservamos la existente.
              */
              ruta_id:
                rutaId ??
                clienteActual.ruta_id,

              /*
              Si el cliente tiene ruta, NO se guarda
              vendedor directo: la ruta es la fuente
              operativa del vendedor.
              */
              vendedor_id:
                rutaId
                  ? null
                  : vendedorDirecto,

              radio_geocerca:
                30,

              activo:
                true
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

            const nuevoCliente =
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
              RETURNING id
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

            clienteIdProcesado =
              nuevoCliente.rows[0].id;

            if (vendedorDirecto) {
              clientesAsignadosDirectamente++;
            }

            importados++;
          }

          /*
          =============================
          GUARDAR ASIGNACIÓN COMERCIAL
          =============================

          El cliente físico sigue siendo único en clientes.
          Cada fila válida del maestro conserva además su
          modalidad + ruta + vendedor + frecuencia.
          */
          if (
            clienteIdProcesado &&
            modalidad
          ) {
            const resultadoAsignacion =
              await guardarAsignacionCliente({
                clienteId:
                  clienteIdProcesado,
                modalidad,
                rutaId,
                vendedorId:
                  vendedor
                    ? vendedor.id
                    : null,
                frecuenciaId
              });

            if (resultadoAsignacion.creada) {
              asignacionesCreadas++;
            } else if (resultadoAsignacion.existente) {
              asignacionesExistentes++;
            }
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
      =================================
      RESOLVER RUTA -> VENDEDOR
      =================================
      */

      const detalleRutas = [];

      for (
        const registro
        of auditoriaRutas.values()
      ) {
        const vendedoresIds =
          [...registro.vendedoresIds];

        const vendedoresExcel =
          [...registro.vendedoresExcel];

        if (
          vendedoresIds.length === 1
        ) {
          const vendedorId =
            vendedoresIds[0];

          const cambioRuta =
            await db.query(
              `
              UPDATE rutas
              SET
                vendedor_id = $1,
                activo = true,
                updated_at =
                  CASE
                    WHEN vendedor_id
                      IS DISTINCT FROM $1
                    THEN NOW()
                    ELSE updated_at
                  END
              WHERE id = $2
              RETURNING
                id,
                nombre,
                vendedor_id
              `,
              [
                vendedorId,
                registro.rutaId
              ]
            );

          if (
            registro.vendedorIdAnterior !==
            vendedorId
          ) {
            rutasAsignadas++;
          } else {
            rutasSinCambio++;
          }

          detalleRutas.push({
            ruta:
              registro.ruta,
            clientes:
              registro.clientes,
            estado:
              "ASIGNADA",
            vendedor:
              registro
                .vendedoresResueltos
                .get(vendedorId),
            vendedor_id:
              vendedorId,
            vendedores_excel:
              vendedoresExcel
          });

        } else if (
          vendedoresIds.length > 1
        ) {
          /*
          Nunca asignamos automáticamente una ruta
          si el Excel trae más de un vendedor real.
          */
          rutasConConflicto++;

          detalleRutas.push({
            ruta:
              registro.ruta,
            clientes:
              registro.clientes,
            estado:
              "CONFLICTO",
            vendedores:
              vendedoresIds.map(
                id =>
                  registro
                    .vendedoresResueltos
                    .get(id)
              ),
            vendedores_excel:
              vendedoresExcel
          });

          advertencias.push({
            ruta:
              registro.ruta,
            motivo:
              `La ruta ${registro.ruta} aparece con más de un vendedor ` +
              `en el Excel. No se modificó el vendedor de la ruta.`,
            vendedores:
              vendedoresIds.map(
                id =>
                  registro
                    .vendedoresResueltos
                    .get(id)
              )
          });

        } else {
          /*
          Ningún vendedor pudo resolverse para la ruta.
          No borramos una asignación anterior porque
          sería riesgoso hacerlo automáticamente.
          */
          rutasSinVendedorExcel++;

          detalleRutas.push({
            ruta:
              registro.ruta,
            clientes:
              registro.clientes,
            estado:
              "SIN_VENDEDOR_RESUELTO",
            vendedor_anterior_id:
              registro.vendedorIdAnterior,
            vendedores_excel:
              vendedoresExcel,
            clientes_sin_vendedor_resuelto:
              registro.clientesSinVendedor
          });
        }
      }

      /*
      =================================
      SUSPENDER CLIENTES AUSENTES
      =================================
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
          resultadoSuspendidos
            .rows.length;
      }

      /*
      =================================
      AUDITORÍA FINAL DEL PADRÓN
      =================================
      */

      const rutasProblemaResult =
        await db.query(
          `
          SELECT
            r.id AS ruta_id,
            r.nombre AS ruta,
            COUNT(c.id)::int
              AS clientes_activos
          FROM rutas r
          INNER JOIN clientes c
            ON c.ruta_id = r.id
           AND c.deleted_at IS NULL
           AND c.activo = true
          WHERE r.activo = true
            AND r.vendedor_id IS NULL
          GROUP BY
            r.id,
            r.nombre
          ORDER BY
            r.nombre
          `
        );

      const clientesSinRutaResult =
        await db.query(
          `
          SELECT
            COUNT(*)::int AS total
          FROM clientes
          WHERE deleted_at IS NULL
            AND activo = true
            AND ruta_id IS NULL
          `
        );

      const clientesSinRutaNiVendedorResult =
        await db.query(
          `
          SELECT
            COUNT(*)::int AS total
          FROM clientes
          WHERE deleted_at IS NULL
            AND activo = true
            AND ruta_id IS NULL
            AND vendedor_id IS NULL
          `
        );

      const clientesSinFrecuenciaResult =
        await db.query(
          `
          SELECT
            COUNT(*)::int AS total
          FROM clientes
          WHERE deleted_at IS NULL
            AND activo = true
            AND frecuencia_id IS NULL
          `
        );

      const clientesSinCoordenadasResult =
        await db.query(
          `
          SELECT
            COUNT(*)::int AS total
          FROM clientes
          WHERE deleted_at IS NULL
            AND activo = true
            AND (
              latitud IS NULL
              OR longitud IS NULL
              OR latitud = 0
              OR longitud = 0
            )
          `
        );

      const rutasSinVendedor =
        rutasProblemaResult.rows;

      const clientesAfectadosPorRutasSinVendedor =
        rutasSinVendedor.reduce(
          (
            acumulado,
            ruta
          ) =>
            acumulado +
            Number(
              ruta.clientes_activos || 0
            ),
          0
        );

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
        rutasSinCambio,
        rutasConConflicto,
        rutasSinVendedorExcel,

        clientesAsignadosDirectamente,

        asignacionesComerciales: {
          creadas:
            asignacionesCreadas,

          ya_existentes:
            asignacionesExistentes,

          filas_sin_modalidad:
            filasSinModalidad,

          modalidades_no_reconocidas:
            modalidadesNoReconocidas
        },

        vendedoresEncontrados:
          vendedoresEncontrados.size,

        resolucionVendedores: {
          por_legajo:
            vendedoresPorLegajo,

          por_nombre_exacto:
            vendedoresExactos,

          por_nombre_flexible:
            vendedoresFlexibles,

          no_encontrados:
            vendedoresNoEncontrados,

          ambiguos:
            vendedoresAmbiguos
        },

        auditoriaFinal: {
          rutas_sin_vendedor:
            rutasSinVendedor.length,

          clientes_afectados_por_rutas_sin_vendedor:
            clientesAfectadosPorRutasSinVendedor,

          detalle_rutas_sin_vendedor:
            rutasSinVendedor,

          clientes_sin_ruta:
            clientesSinRutaResult
              .rows[0]
              .total,

          clientes_sin_ruta_ni_vendedor:
            clientesSinRutaNiVendedorResult
              .rows[0]
              .total,

          clientes_sin_frecuencia:
            clientesSinFrecuenciaResult
              .rows[0]
              .total,

          clientes_sin_coordenadas:
            clientesSinCoordenadasResult
              .rows[0]
              .total
        },

        detalleRutas,

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

    } finally {
      if (
        archivoTemporal &&
        fs.existsSync(
          archivoTemporal
        )
      ) {
        try {
          fs.unlinkSync(
            archivoTemporal
          );
        } catch (errorBorrado) {
          console.error(
            "NO SE PUDO BORRAR ARCHIVO TEMPORAL:",
            errorBorrado.message
          );
        }
      }
    }
  }
);

module.exports = router;