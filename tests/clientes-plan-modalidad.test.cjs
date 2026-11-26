const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/clientes.routes.js'), 'utf8');

// Ejecutar el JOIN real de cada consulta, con un cliente de ejecución que
// conserva dos asignaciones: presencial a ruta 3 y Televentas a ruta 2.
for (const [name, marker, clientAlias] of [
  ['plan diario', '"/plan-trabajo/:vendedor_id"', 'c'],
  ['APK del vendedor', 'asignaciones_apk AS (', 'c_apk']
]) {
  test(`${name}: ejecución no incorpora una asignación de modalidad deshabilitada`, () => {
    const section = source.slice(source.indexOf(marker));
    const join = section.match(/INNER JOIN modalidades_atencion ma\s+ON ma\.codigo = asig\.modalidad[\s\S]*?(?=LEFT JOIN rutas r)/)?.[0];
    assert.ok(join, 'Se encontró el JOIN de modalidades de la consulta');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE clientes(id TEXT, es_ejecucion INTEGER);
        CREATE TABLE clientes_asignaciones(cliente_id TEXT, modalidad TEXT, ruta_id TEXT);
        CREATE TABLE modalidades_atencion(codigo TEXT, activo INTEGER, enviar_apk INTEGER);
        INSERT INTO clientes VALUES ('54645',1),('normal',0);
        INSERT INTO modalidades_atencion VALUES ('PR',1,1),('TA',1,0),('BAJA',0,1);
        INSERT INTO clientes_asignaciones VALUES
          ('54645','PR','3'),('54645','TA','2'),('54645','BAJA','2'),
          ('normal','PR','3'),('normal','TA','2');
      `);
      const query = `SELECT asig.cliente_id,asig.ruta_id FROM clientes_asignaciones asig
        JOIN clientes ${clientAlias} ON ${clientAlias}.id=asig.cliente_id ${join}
        ORDER BY asig.cliente_id`;
      const result = db.prepare(query).all().map(r => ({...r}));
      assert.deepEqual(result, [
        {cliente_id:'54645',ruta_id:'3'}, {cliente_id:'normal',ruta_id:'3'}
      ]);
      // Si oficina habilita expresamente otra modalidad, se respeta esa opción.
      db.exec("UPDATE modalidades_atencion SET enviar_apk=1 WHERE codigo='TA'");
      assert.equal(db.prepare(query).all().length, 4);
    } finally { db.close(); }
  });
}
