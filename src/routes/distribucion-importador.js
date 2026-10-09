const XLSX = require('xlsx');

function identificador(v) { return v == null ? '' : String(v).trim(); }
function numero(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw Error('Número inválido');
    return v;
  }
  const s = identificador(v);
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  if (!Number.isFinite(n)) throw Error('Número inválido: ' + s);
  return n;
}
function fecha(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) throw Error('Fecha inválida');
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s = identificador(v).slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw Error('Fecha inválida: ' + s);
  return s;
}
function leer(buffer) {
  const wb = XLSX.read(buffer, {type:'buffer', cellDates:true});
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:null});
}
function pedidos(buffer, empresa, clientes = {}) {
  const rows = leer(buffer), seen = new Set(), agrupados = new Map(), errores = [], resultado = [];
  if (!rows.length) throw Error('El archivo no tiene registros');
  for (const k of ['COD_CLI','FECHAENTREGA']) {
    if (!(k in rows[0])) throw Error('Falta columna ' + k);
  }
  const tienePedido = 'PEDIDO' in rows[0];
  if (!tienePedido && !('N_DESPACHO' in rows[0])) throw Error('Falta columna PEDIDO o N_DESPACHO');
  rows.forEach((r,i) => {
    try {
      const codigo = identificador(r.COD_CLI), despacho = identificador(r.N_DESPACHO);
      if (!codigo) throw Error('Cliente vacío');
      const dia = fecha(r.FECHAENTREGA);
      // Sin número de pedido, cada parada tiene una referencia estable.
      // No depende del orden de las filas y conserva los pedidos numerados.
      const pedido = tienePedido ? identificador(r.PEDIDO) :
        'AUTO:' + JSON.stringify([despacho, codigo]);
      if (tienePedido && !pedido) throw Error('Pedido vacío');
      if (!tienePedido && !despacho) throw Error('Despacho vacío: necesario cuando no hay PEDIDO');
      const key = JSON.stringify([empresa, dia, pedido]);
      const c = clientes[codigo];
      const p = {empresa, fecha:dia, codigo, pedido, cliente:identificador(r.CLIENTE),
        conductor:identificador(r.Chofer), despacho,
        cantidad:numero(r.CANTIDAD), importe:numero(r.IMPORTE),
        lat:c?.lat ?? null, lng:c?.lng ?? null, direccion:c?.direccion ?? '',
        coincidencia:!!c, estado:'Pendiente'};
      if (tienePedido) {
        if (seen.has(key)) throw Error('Pedido duplicado en el archivo');
        seen.add(key);
        resultado.push(p);
      } else {
        const anterior = agrupados.get(key);
        if (anterior) {
          if (anterior.conductor !== p.conductor) throw Error('Cliente y despacho con distintos conductores');
          for (const campo of ['cantidad','importe']) {
            if (p[campo] !== null) anterior[campo] = (anterior[campo] ?? 0) + p[campo];
          }
        } else {
          agrupados.set(key, p);
          resultado.push(p);
        }
      }
    } catch(e) { errores.push({fila:i+2,motivo:e.message}); }
  });
  return {pedidos:resultado, errores};
}
function vehiculos(buffer, empresa) {
  const rows = leer(buffer), seen = new Set();
  return rows.map((r,i) => {
    const interno=identificador(r.INTERNO), patente=identificador(r.PATENTE).toUpperCase(), tipo=identificador(r.TIPO).toLowerCase();
    if (!interno || !patente || !['camion','tractor','semi'].includes(tipo)) throw Error('Fila '+(i+2)+': completar INTERNO, PATENTE y TIPO (camion/tractor/semi)');
    if (seen.has(interno)) throw Error('Interno duplicado: '+interno);
    seen.add(interno); return {empresa,interno,patente,tipo};
  });
}
module.exports={pedidos,vehiculos,numero};