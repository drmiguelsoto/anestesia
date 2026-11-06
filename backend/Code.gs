/**
 * Honorarios de Anestesia — Dr. Miguel Soto Universe
 * Backend (Google Apps Script, App web) + base de datos en Google Sheets.
 *
 * Flujo: agenda cirugiasotodamian → caso precargado → el anestesiólogo confirma
 * (agrega adicionales, médico externo, VPA) → el aprobador aprueba → el
 * anestesiólogo sube su CFDI (XML + PDF) que la app valida → quien paga hace la
 * SPEI y sube el comprobante → pagado.
 *
 * Reglas del tabulador (dictadas por el Dr. Soto, 5 nov 2026):
 *  - Base = el procedimiento MÁS CARO del tabulador.
 *  - + $550 por CADA procedimiento extra.
 *  - + $1,100 por cada médico externo que hace un procedimiento en el mismo acto.
 *  - + $880 de valoración preanestésica sólo si se realizó y está completa.
 *  - Reintervención (hematoma, reoperar una cirugía propia previa) = $2,000 en
 *    lugar de la base. Rinoplastía secundaria sólo si la primaria NO fue suya.
 *  - Sedaciones (energy devices, procedimientos menores) = $2,000.
 *  - Anestesia local: no hay anestesiólogo. Ángeles del Pedregal: el
 *    anestesiólogo cobra a la aseguradora con carta pase; no entra aquí.
 *
 * Quién paga (5 nov 2026): según la sede. Zorvix → Miguel Soto, persona física.
 * Renasté → Renasté, persona moral. Sin sede en la agenda → el aprobador lo elige.
 * Una factura sólo puede llevar casos de un mismo pagador y debe venir a su RFC.
 *
 * Instalación: correr bootstrap() una vez, llenar la hoja Config, correr
 * instalarDisparador(), publicar como App web (Ejecutar como: yo; Acceso: cualquiera).
 */

var VERSION = '1.2';
var TZ = 'America/Mexico_City';
var PROP = PropertiesService.getScriptProperties();

/* ===================== Esquema ===================== */

var ESQUEMA = {
  Config: ['Clave', 'Valor', 'Descripcion'],
  Tabulador: ['Concepto_ID', 'Categoria', 'Concepto', 'Nombre_Hoja_Costos', 'Tipo', 'Monto_Respaldo', 'Activo'],
  Equivalencias: ['Nombre_Agenda', 'Clave_Normal', 'Concepto_ID', 'Notas', 'Veces_Visto', 'Ultima_Vez'],
  Anestesiologos: ['Email', 'Nombre', 'Nombre_Agenda', 'RFC', 'Banco', 'CLABE', 'Activo'],
  Usuarios: ['Email', 'Nombre', 'Rol', 'Activo'],
  Pagadores: ['Pagador_ID', 'Nombre', 'Razon_Social', 'RFC', 'Patron_Sede', 'Pagan', 'Activo'],
  Casos: ['Caso_ID', 'Evento_ID', 'VPA_Evento_ID', 'Fecha_Cirugia', 'Paciente', 'COT', 'Sede',
    'Tipo_Anestesia', 'Texto_Agenda', 'Origen', 'Anestesiologo_Email', 'Estado',
    'VPA_Agenda', 'VPA_Cobra', 'Medicos_Externos', 'Reintervencion', 'Reintervencion_Ref',
    'Base_Concepto', 'Base_Monto', 'Adicionales_N', 'Adicionales_Monto', 'Externos_Monto',
    'VPA_Monto', 'Total', 'Sin_Mapear', 'Solicitud_ID', 'Confirmado_En', 'Aprobado_Por',
    'Aprobado_En', 'Motivo', 'Creado_En', 'Actualizado_En', 'Pagador'],
  Lineas: ['Linea_ID', 'Caso_ID', 'Origen', 'Texto', 'Concepto_ID', 'Activa', 'Agregado_Por', 'Agregado_En'],
  Solicitudes: ['Solicitud_ID', 'Anestesiologo_Email', 'Casos', 'Total_Casos', 'UUID', 'RFC_Emisor',
    'RFC_Receptor', 'Total_CFDI', 'Fecha_CFDI', 'Estado_SAT', 'XML_ID', 'PDF_ID', 'Estado',
    'Creado_En', 'Comprobante_ID', 'Referencia_Pago', 'Pagado_Por', 'Pagado_En', 'Motivo', 'Pagador'],
  Bitacora: ['Fecha', 'Usuario', 'Accion', 'Objeto', 'Detalle']
};

var CONFIG_SEMILLA = [
  ['CALENDARIO_ID', 'cirugiasotodamian@gmail.com', 'Agenda de donde se jalan los casos'],
  ['COSTOS_ID', '1fuGfx6t3upxK5JEZt9cFVbvJYlwJxAAkkoRiXQ5GAFw', 'Hoja "Costos Anestesia 2026": de aquí salen los montos'],
  ['OAUTH_CLIENT_ID', '', 'Cliente OAuth web del login de Google (mismo de las demás apps)'],
  ['RFC_RECEPTOR', '', 'Ya no se usa: el RFC de cada pagador vive en la hoja Pagadores'],
  ['CARPETA_ID', '', 'Carpeta de Drive para facturas y comprobantes (la crea bootstrap)'],
  ['DIAS_ATRAS', '90', 'Días hacia atrás que revisa la sincronización'],
  ['DIAS_ADELANTE', '30', 'Días hacia adelante (casos programados)'],
  ['TOLERANCIA_PESOS', '1', 'Diferencia máxima entre total de factura y total aprobado'],
  ['SEDES_EXCLUIDAS', 'angeles|pedregal|hap', 'Sedes que no entran (el anestesiólogo cobra a la aseguradora)'],
  ['FECHA_INICIO', '2026-11-06', 'Cirugías anteriores a esta fecha no entran a la app'],
  ['ANESTESIOLOGO_DEFAULT', 'islas.fer3@gmail.com', 'A quién se asignan los casos sin anestesiólogo identificado en la agenda']
];

// El tabulador vive en la hoja "Costos Anestesia 2026" (COSTOS_ID en Config): los montos se leen
// de ahí en cada cálculo. Aquí sólo va qué renglón de esa hoja corresponde a cada concepto.
// [Concepto_ID, Categoria, Concepto, Nombre exacto en la hoja de costos, Tipo, Monto de respaldo]
var TABULADOR_SEMILLA = [
  ['R01', 'Rostro', 'Bichectomía / Mucoplastia', 'Bichectomía / Mucoplastia', 'Procedimiento', ''],
  ['R02', 'Rostro', 'Blefaroplastía', 'Blefaroplastía', 'Procedimiento', ''],
  ['R03', 'Rostro', 'Deep Plane Mejillas y Cuello', 'Deep Plane Mejillas y Cuello', 'Procedimiento', ''],
  ['R04', 'Rostro', 'Deep Plane Full System', 'Deep Plane Full System (Abarca todo ej. tercio superior, labios, CO2)', 'Procedimiento', ''],
  ['R05', 'Rostro', 'Implante Ángulos Mandibulares', 'Implante Ángulos Mandibulares', 'Procedimiento', ''],
  ['R06', 'Rostro', 'Implantes de Pómulo', 'Implantes de Pómulo', 'Procedimiento', ''],
  ['R07', 'Rostro', 'Lip Lifting (Boca)', 'Lip Lifting (Boca)', 'Procedimiento', ''],
  ['R08', 'Rostro', 'Lobuloplastía', 'Lobuloplastía', 'Procedimiento', ''],
  ['R09', 'Rostro', 'Mentoplastía', 'Mentoplastía', 'Procedimiento', ''],
  ['R10', 'Rostro', 'Otoplastía', 'Otoplastía', 'Procedimiento', ''],
  ['R11', 'Rostro', 'Pexia Ceja', 'Pexia Ceja', 'Procedimiento', ''],
  ['R12', 'Rostro', 'Rinoplastía Primaria / Secundaria', 'Rinoplastía Primaria/Secundaria', 'Procedimiento', ''],
  ['M01', 'Mama', 'Corrección Ginecomastia', 'Corrección Ginecomastia', 'Procedimiento', ''],
  ['M02', 'Mama', 'Implantes mamarios / Expansores', 'Implantes mamarios (colocacion/retiro)/ Colocacion de expansores mamarios', 'Procedimiento', ''],
  ['M03', 'Mama', 'Mamoplastía de Reducción / Mastopexia / Mastectomía', 'Mamoplastía de Reducción/ Mastopexia/ Mastectomia profilactica (con o sin implantes)', 'Procedimiento', ''],
  ['C01', 'Contorno corporal', 'Abdominoplastía', 'Abdominoplastía', 'Procedimiento', ''],
  ['C02', 'Contorno corporal', 'Miniabdominoplastía', 'Miniabdominoplastía', 'Procedimiento', ''],
  ['C03', 'Contorno corporal', 'Plastía Cicatriz Abdominoplastía', 'Plastía Cicatriz Abdominoplastía', 'Procedimiento', ''],
  ['C04', 'Contorno corporal', 'Liposucción (Body360, Body500, Tummy360)', 'Liposuccion (Body 360, Body500, Tummy 360)', 'Procedimiento', ''],
  ['C05', 'Contorno corporal', 'Liposucción 1 área', 'Liposuccion 1 area', 'Procedimiento', ''],
  ['C06', 'Contorno corporal', 'RibXcar', 'RibXcar', 'Procedimiento', ''],
  ['C07', 'Contorno corporal', 'Braquiplastía', 'Braquiplastía', 'Procedimiento', ''],
  ['C08', 'Contorno corporal', 'Braquiplastía Incisión Axilar', 'Braquiplastía Incisión Axilar', 'Procedimiento', ''],
  ['C09', 'Contorno corporal', 'Musloplastía', 'Musloplastía (incluye Lipo de Muslos)', 'Procedimiento', ''],
  ['C10', 'Contorno corporal', 'Musloplastía Incisión Inguinal', 'Musloplastía Incisión Inguinal (incluye Lipo de Muslos)', 'Procedimiento', ''],
  ['C11', 'Contorno corporal', 'Implantes de Glúteos', 'Implantes de Glúteos (Incluye Lipo de Cintura) Colocacion/Retiro', 'Procedimiento', ''],
  ['C12', 'Contorno corporal', 'Implantes de Pantorrilla', 'Implantes de Pantorrilla', 'Procedimiento', ''],
  ['C13', 'Contorno corporal', 'Implantes de Pectorales', 'Implantes de Pectorales', 'Procedimiento', ''],
  ['C14', 'Contorno corporal', 'Cellfina', 'Cellfina', 'Procedimiento', ''],
  ['G01', 'Genital', 'Faloplastía Parcial', 'Faloplastía Parcial (Engrosamiento)', 'Procedimiento', ''],
  ['G02', 'Genital', 'Faloplastía Total', 'Faloplastía Total (Engrosamiento)', 'Procedimiento', ''],
  ['G03', 'Genital', 'Labioplastia Genital', 'Labioplastia Genital', 'Procedimiento', ''],
  ['O01', 'Otros', 'Aloplastía', 'Aloplastía', 'Procedimiento', ''],
  ['S01', 'Sedación', 'Sedación (energy devices / procedimiento menor)', 'Sedación', 'Sedacion', 2000],
  ['NC', 'Sin cargo', 'No genera honorario (botox, hialuronidasa, sueros)', '', 'No_cuenta', 0],
  ['X_ADIC', 'Cargos', 'Procedimiento adicional', 'Procedimiento adicional', 'Cargo', ''],
  ['X_EXT', 'Cargos', 'Anestesia médico externo', 'Anestesia medico adicional', 'Cargo', ''],
  ['X_REINT', 'Cargos', 'Anestesia reintervención', 'Anestesia reintervencion', 'Cargo', ''],
  ['X_VPA', 'Cargos', 'Valoración preanestésica (incluye EKG)', 'Valoracion PreAnestesica (incluye tomar EKG)', 'Cargo', '']
];

// Nombres vistos en la agenda jun–dic 2026 → concepto. "confirmar" = mapeo supuesto.
var EQUIVALENCIAS_SEMILLA = [
  ['Deep Plane Lifting Hybrid MS® Full System', 'R04', ''],
  ['Deep Plane Lifting Endoscopic MS® Full Face', 'R04', ''],
  ['Edoscopic deep plane full system', 'R04', ''],
  ['Deep Plane Lifting Hybrid MS® Tercio medio inferior y cuello', 'R03', ''],
  ['Deep Plane Lifting Hybrid MS® Lower Face & Neck', 'R03', ''],
  ['Deep Plane cara y cuello', 'R03', ''],
  ['Deep Plane Mejillas', 'R03', ''],
  ['Deep Plane', 'R03', 'confirmar: sin especificar alcance'],
  ['Deep Plane Papada (Definición de Contorno)', 'R03', 'confirmar'],
  ['Deep Plane Endoscopic MS® Tercio Superior', 'R11', 'confirmar: tercio superior = pexia de ceja'],
  ['Rinoplastía Ultrasónica', 'R12', ''],
  ['Rinoplastía Ultrasónica Secundaria', 'R12', 'si la primaria fue suya es reintervención'],
  ['Rinoplastia', 'R12', ''],
  ['Punta nasal', 'R12', 'confirmar'],
  ['Blefaroplastía 4 Cuadrantes', 'R02', ''],
  ['Blefaro 4 cuadrantes', 'R02', ''],
  ['Blefaroplastía Párpados Inferiores', 'R02', ''],
  ['Mentoplastía', 'R09', ''],
  ['Implantes de Pómulo', 'R06', ''],
  ['Implante de pómulo', 'R06', ''],
  ['Bichetomia', 'R01', ''],
  ['Bichectomía', 'R01', ''],
  ['Lobuloplastía', 'R08', ''],
  ['Otoplastía', 'R10', ''],
  ['Body 360', 'C04', ''],
  ['Body 500', 'C04', ''],
  ['Qx Tummy360', 'C04', ''],
  ['Tummy 360', 'C04', ''],
  ['Lipo High Tech 1 área', 'C05', ''],
  ['Lipo High Tech Papada', 'C05', 'confirmar'],
  ['RibXcar', 'C06', ''],
  ['RibXcar (Lipo Previa)', 'C06', ''],
  ['Cellfina 20', 'C14', ''],
  ['Cellfina', 'C14', ''],
  ['Abdominoplastía', 'C01', ''],
  ['Miniabdominoplastía', 'C02', ''],
  ['Mamoplastía de Aumento', 'M02', ''],
  ['Mamoplastia', 'M02', 'confirmar: aumento o reducción'],
  ['Cambio de Implantes', 'M02', ''],
  ['Retiro de implantes', 'M02', ''],
  ['Mastopexia', 'M03', ''],
  ['Mastopexia con Implantes', 'M03', ''],
  ['Mastopexia Profiláctica con Implantes', 'M03', ''],
  ['Labioplastía Genital (Labios menores)', 'G03', ''],
  ['Labioplastia Genital', 'G03', ''],
  ['Aloplastia', 'O01', ''],
  ['Morpheus8', 'S01', ''], ['Morpheus8 cara y cuello', 'S01', ''], ['M8', 'S01', ''],
  ['M8 cara y cuello', 'S01', ''], ['M8 cara, cuello y brazos', 'S01', ''],
  ['eCO2', 'S01', ''], ['eCO2 cara y cuello', 'S01', ''], ['eCO2 cara completa', 'S01', ''],
  ['eCO2 cara', 'S01', ''], ['Laser eCO2', 'S01', ''], ['CO2 cara', 'S01', ''],
  ['CO2 cara y cuello', 'S01', ''], ['CO2 cara y manos', 'S01', ''],
  ['Skin Resurfacing (Laser Peel) Rostro', 'S01', ''], ['Skinresurfacing cara', 'S01', ''],
  ['Endolifting Facial', 'S01', ''], ['Endolifting', 'S01', ''], ['Endolift', 'S01', ''],
  ['Endolift cara y cuello', 'S01', ''], ['Endo cara y cuello', 'S01', ''], ['Endo', 'S01', ''],
  ['Endo Corporal', 'S01', ''], ['Ultherapy cara completa', 'S01', ''],
  ['Ultherapy cara completa y cuello completo', 'S01', ''], ['Ultera cara y cuello', 'S01', ''],
  ['Skin Restructuring Cicatrices de 6-10 cm', 'S01', ''], ['Renewed Skin', 'S01', ''],
  ['Sculptra', 'S01', ''], ['Facial Fat Grafting', 'S01', 'confirmar'],
  ['Lipotransferencia a cara', 'S01', 'confirmar'], ['Radiofrecuencia en cornetes', 'S01', ''],
  ['Retiro de quiste', 'S01', ''], ['Retiro de absceso', 'S01', ''], ['Retiro de lipoma', 'S01', ''],
  ['Infiltración de cicatrices', 'S01', ''], ['Rinomodelación', 'S01', 'confirmar'],
  ['Botox', 'NC', ''], ['Botox FF', 'NC', ''], ['Botox frente y entrecejo', 'NC', ''],
  ['Botox en frente', 'NC', ''], ['Bótox full face', 'NC', ''], ['Hialuronidasa', 'NC', ''],
  ['Suero fisiológico intravenoso y renegy', 'NC', ''], ['Renneva Lite', 'NC', ''],
  ['cuello completo', 'NC', 'fragmento de "Ultherapy cara completa + cuello completo"']
];

// Quién paga según la sede. Patron_Sede = expresión que se busca en la sede (sin acentos, minúsculas).
// Pagan = correos (separados por coma) de quien registra los pagos de ese pagador; el admin paga todos.
var PAGADORES_SEMILLA = [
  ['PF', 'Zorvix · Miguel Soto, persona física', 'MIGUEL ANGEL SOTO MIRANDA', 'SOMM790130NHA', 'zorvix', '', 'Sí'],
  ['RENASTE', 'Renasté · persona moral', '', '', 'renaste', '', 'Sí']
];

/** Pagador que corresponde a una sede ('' si no hay sede o ninguna regla aplica). */
function pagadorDeSede(sede, pagadores) {
  var t = norm(sede);
  if (!t) return '';
  for (var i = 0; i < pagadores.length; i++) {
    var p = pagadores[i];
    if (p.Activo === 'No' || !p.Patron_Sede) continue;
    if (new RegExp(p.Patron_Sede, 'i').test(t)) return p.Pagador_ID;
  }
  return '';
}

var ESTADOS = ['Programado', 'Por_confirmar', 'Por_aprobar', 'Aprobado', 'En_cobro', 'Pagado', 'Rechazado', 'Excluido'];

/* ===================== Utilidades puras (también se prueban en node) ===================== */

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/®|™/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function limpiarDescripcion(d) {
  var s = String(d || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/ /g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  // Las agendas viejas vienen en una sola línea: se parte antes de cada emoji marcador.
  s = s.replace(/([\u{1F300}-\u{1FAFF}☀-➿⬀-⯿])/gu, '\n$1');
  return s;
}

function campo(ds, etiquetas) {
  for (var i = 0; i < etiquetas.length; i++) {
    var re = new RegExp(etiquetas[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^\\n]*)', 'i');
    var m = ds.match(re);
    if (m) return m[1].replace(/\*/g, '').trim();
  }
  return '';
}

function quitarEmojis(s) {
  return String(s || '').replace(/[\u{1F000}-\u{1FAFF}☀-➿⬀-⯿️‍]/gu, '').trim();
}

/** Interpreta un evento de la agenda (objeto con summary, description, start, status, id). */
function parsearEvento(ev) {
  var titulo = String(ev.summary || '');
  var ds = limpiarDescripcion(ev.description);
  var r = {
    id: ev.id, titulo: titulo, fecha: ev.start, tipo: 'libre', paciente: '', cot: '',
    anestesia: '', sede: '', operativo: '', procedimientos: [], texto: '',
    cancelado: /\[CANCELADA\]/i.test(titulo) || ev.status === 'cancelled',
    asistencia: '', motivo: ''
  };
  var asis = campo(ds, ['ASISTENCIA']);
  r.asistencia = /^s[ií]/i.test(asis) ? 'Sí' : (/^no/i.test(asis) ? 'No' : '');

  var mp = titulo.match(/Paciente:\s*(.+?)(?:📱|Tel[eé]fono|🧑|$)/);
  if (mp) r.paciente = quitarEmojis(mp[1]).trim();
  else r.paciente = quitarEmojis(titulo.replace(/\[CANCELADA\]/i, '')).replace(/\+?\d[\d\s-]{7,}$/, '').trim();

  r.motivo = campo(ds, ['Motivo de visita']);
  r.anestesia = (campo(ds, ['Anestesia']).split(/\s/)[0] || '');
  r.sede = campo(ds, ['Sede']);
  r.operativo = campo(ds, ['Operativo']);
  var cotm = ds.match(/COT-\d+/);
  if (cotm) r.cot = cotm[0];

  if (/evento personal/i.test(titulo) || /evento personal/i.test(r.motivo)) { r.tipo = 'ignorar'; return r; }

  if (r.motivo) {
    var mot = norm(r.motivo);
    if (mot.indexOf('vpa') === 0) r.tipo = 'vpa';
    else r.tipo = 'estructurado';
    var cp = campo(ds, ['Cirugía Programada', 'Cirugia Programada', 'Cirugia Programado', 'Tratamiento programado', 'Procedimiento']);
    cp = cp.replace(/\[?COT-\d+\]?/g, '').replace(/Cotizaci[oó]n/gi, '').replace(/\(Queda Incluido[^)]*\)/i, '');
    r.texto = cp.trim();
    cp.split(/\s*\+\s*/).forEach(function (p) {
      p = p.replace(/^[\s.,]+|[\s.,]+$/g, '');
      if (p) r.procedimientos.push(p);
    });
  } else {
    // Evento capturado a mano: la descripción es texto libre.
    r.texto = quitarEmojis(ds.split('\n').filter(function (l) {
      return l.trim() && !/ESTATUS|ASISTENCIA|Ajuste de operativo|Operativo:/i.test(l);
    }).slice(0, 3).join(' ')).trim();
    var t = norm(r.texto + ' ' + titulo);
    if (/sedaci/.test(t)) r.anestesia = 'Sedación';
    else if (/\blocal\b/.test(t)) r.anestesia = 'Local';
    else if (/\bgeneral\b/.test(t)) r.anestesia = 'General';
    if (/\bhap\b|angeles|pedregal/.test(t)) r.sede = 'Angeles del Pedregal';
    if (norm(r.texto) === 'vpa' || /^vpa\b/.test(norm(r.texto))) r.tipo = 'vpa';
  }
  return r;
}

/** Busca equivalencias. eqs: [{clave, concepto}] con clave normalizada. */
function mapearTexto(texto, eqs) {
  var k = norm(texto);
  for (var i = 0; i < eqs.length; i++) if (eqs[i].clave === k) return eqs[i].concepto;
  return '';
}

/** Para texto libre: encuentra todas las equivalencias contenidas, la más larga primero, sin traslapes. */
function buscarEnTextoLibre(texto, eqs) {
  var t = ' ' + norm(texto) + ' ';
  var orden = eqs.filter(function (e) { return e.clave.length >= 4; })
    .sort(function (a, b) { return b.clave.length - a.clave.length; });
  var hallados = [];
  orden.forEach(function (e) {
    var needle = ' ' + e.clave + ' ';
    var pos = t.indexOf(needle);
    if (pos >= 0) {
      hallados.push({ texto: e.nombre, concepto: e.concepto });
      t = t.slice(0, pos) + ' ' + Array(needle.length - 1).join('#') + ' ' + t.slice(pos + needle.length);
    }
  });
  return hallados;
}

/**
 * Calcula el honorario.
 * lineas: [{concepto, activa}] ; tab: {id: {monto, tipo}} ; f: {externos, vpa, reintervencion}
 */
function calcular(lineas, tab, f) {
  var cuentan = [], sinMapear = 0;
  lineas.forEach(function (l) {
    if (!l.activa) return;
    if (!l.concepto) { sinMapear++; return; }
    var c = tab[l.concepto];
    if (!c) { sinMapear++; return; }
    if (c.tipo === 'Procedimiento' || c.tipo === 'Sedacion') cuentan.push({ id: l.concepto, monto: Number(c.monto) });
  });
  cuentan.sort(function (a, b) { return b.monto - a.monto; });
  var r = { baseConcepto: '', baseMonto: 0, adicionalesN: 0, adicionalesMonto: 0, externosMonto: 0, vpaMonto: 0, total: 0, sinMapear: sinMapear };
  if (cuentan.length) {
    r.baseConcepto = cuentan[0].id;
    r.baseMonto = cuentan[0].monto;
    r.adicionalesN = cuentan.length - 1;
  }
  if (f.reintervencion) { r.baseConcepto = 'X_REINT'; r.baseMonto = Number(tab.X_REINT.monto); }
  r.adicionalesMonto = r.adicionalesN * Number(tab.X_ADIC.monto);
  r.externosMonto = (Number(f.externos) || 0) * Number(tab.X_EXT.monto);
  r.vpaMonto = f.vpa ? Number(tab.X_VPA.monto) : 0;
  r.total = r.baseMonto + r.adicionalesMonto + r.externosMonto + r.vpaMonto;
  return r;
}

/** Lee los datos clave de un CFDI 3.3/4.0. */
function leerCFDI(xml) {
  var s = String(xml || '');
  function attr(tagRe, a) {
    var m = s.match(new RegExp('<' + tagRe + '\\b[^>]*>', 'i'));
    if (!m) return '';
    var mm = m[0].match(new RegExp('\\s' + a + '\\s*=\\s*"([^"]*)"', 'i'));
    return mm ? mm[1] : '';
  }
  return {
    total: attr('(?:cfdi:)?Comprobante', 'Total'),
    fecha: attr('(?:cfdi:)?Comprobante', 'Fecha'),
    tipo: attr('(?:cfdi:)?Comprobante', 'TipoDeComprobante'),
    rfcEmisor: attr('(?:cfdi:)?Emisor', 'Rfc').toUpperCase(),
    nombreEmisor: attr('(?:cfdi:)?Emisor', 'Nombre'),
    rfcReceptor: attr('(?:cfdi:)?Receptor', 'Rfc').toUpperCase(),
    uuid: attr('(?:tfd:)?TimbreFiscalDigital', 'UUID').toUpperCase()
  };
}

/* ===================== Hojas ===================== */

function libro_() {
  var id = PROP.getProperty('LIBRO_ID');
  if (!id) throw new Error('Falta LIBRO_ID: corre bootstrap()');
  return SpreadsheetApp.openById(id);
}

function hoja_(nombre) {
  var h = libro_().getSheetByName(nombre);
  if (!h) throw new Error('No existe la hoja ' + nombre);
  return h;
}

function leer_(nombre) {
  var h = hoja_(nombre);
  var v = h.getDataRange().getValues();
  var enc = v.shift().map(String);
  // El número de fila se toma ANTES de saltar renglones vacíos, para no escribir en la fila equivocada.
  return v.map(function (r, i) { return { r: r, fila: i + 2 }; }).filter(function (x) { return x.r.join('') !== ''; }).map(function (x) {
    var o = { _fila: x.fila };
    enc.forEach(function (c, j) { o[c] = x.r[j]; });
    return o;
  });
}

function anexar_(nombre, obj) {
  var h = hoja_(nombre);
  var enc = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0];
  h.appendRow(enc.map(function (c) { return obj[c] === undefined ? '' : obj[c]; }));
}

function actualizar_(nombre, fila, cambios) {
  var h = hoja_(nombre);
  var enc = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0];
  var rango = h.getRange(fila, 1, 1, enc.length);
  var v = rango.getValues()[0];
  Object.keys(cambios).forEach(function (k) {
    var j = enc.indexOf(k);
    if (j >= 0) v[j] = cambios[k];
  });
  rango.setValues([v]);
}

function config_() {
  var c = {};
  var filas = leer_('Config');
  filas.forEach(function (r) { c[r.Clave] = String(r.Valor).trim(); });
  // Claves nuevas de versiones posteriores: se agregan solas con su valor por omisión.
  CONFIG_SEMILLA.forEach(function (k) {
    if (!(k[0] in c)) { anexar_('Config', { Clave: k[0], Valor: k[1], Descripcion: k[2] }); c[k[0]] = k[1]; }
  });
  return c;
}

var TAB_CACHE = null;
function montosHojaCostos_(cfg) {
  var m = {};
  if (!cfg.COSTOS_ID) return m;
  var v = SpreadsheetApp.openById(cfg.COSTOS_ID).getSheets()[0].getDataRange().getValues();
  v.forEach(function (r) {
    var nombre = norm(r[1]);
    var monto = typeof r[2] === 'number' ? r[2] : Number(String(r[2]).replace(/[$,\s]/g, ''));
    if (nombre && monto > 0) m[nombre] = monto;
  });
  return m;
}

/** Tabulador vigente: renglones de AnestesiaDB con el monto leído de la hoja de costos. */
function tabulador_() {
  if (TAB_CACHE) return TAB_CACHE;
  var hoja = montosHojaCostos_(config_());
  var t = {};
  leer_('Tabulador').forEach(function (r) {
    if (String(r.Activo).toLowerCase() === 'no') return;
    var k = norm(r.Nombre_Hoja_Costos);
    var monto = k && hoja[k] !== undefined ? hoja[k] : Number(r.Monto_Respaldo || 0);
    t[r.Concepto_ID] = { monto: monto, tipo: r.Tipo, concepto: r.Concepto, categoria: r.Categoria, deHoja: !!(k && hoja[k] !== undefined) };
  });
  TAB_CACHE = t;
  return t;
}

function equivalencias_() {
  return leer_('Equivalencias').map(function (r) {
    return { nombre: r.Nombre_Agenda, clave: r.Clave_Normal || norm(r.Nombre_Agenda), concepto: r.Concepto_ID, _fila: r._fila, veces: Number(r.Veces_Visto) || 0 };
  });
}

function ahora_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

var LOCK_TOMADO = false;
function folio_(prefijo) {
  var propio = !LOCK_TOMADO;
  var lock = LockService.getScriptLock();
  if (propio) lock.waitLock(20000);
  try {
    var n = Number(PROP.getProperty('FOLIO_' + prefijo) || 0) + 1;
    PROP.setProperty('FOLIO_' + prefijo, String(n));
    return prefijo + '-' + ('00000' + n).slice(-5);
  } finally { if (propio) lock.releaseLock(); }
}

/** Escribe varias filas de un jalón (mucho más rápido que appendRow una por una). */
function anexarVarios_(nombre, objs) {
  if (!objs.length) return;
  var h = hoja_(nombre);
  var enc = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0];
  var filas = objs.map(function (o) { return enc.map(function (c) { return o[c] === undefined ? '' : o[c]; }); });
  h.getRange(h.getLastRow() + 1, 1, filas.length, enc.length).setValues(filas);
}

function bitacora_(usuario, accion, objeto, detalle) {
  anexar_('Bitacora', { Fecha: ahora_(), Usuario: usuario, Accion: accion, Objeto: objeto, Detalle: typeof detalle === 'string' ? detalle : JSON.stringify(detalle || '') });
}

/* ===================== Instalación ===================== */

function bootstrap() {
  var id = PROP.getProperty('LIBRO_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('AnestesiaDB — Honorarios de Anestesia');
  PROP.setProperty('LIBRO_ID', ss.getId());
  Object.keys(ESQUEMA).forEach(function (n) {
    var h = ss.getSheetByName(n) || ss.insertSheet(n);
    var enc = ESQUEMA[n];
    var actual = h.getLastColumn() ? h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0] : [];
    enc.forEach(function (c) { if (actual.indexOf(c) < 0) { actual.push(c); } });
    h.getRange(1, 1, 1, actual.length).setValues([actual]).setFontWeight('bold').setBackground('#030707').setFontColor('#F4F2F1');
    h.setFrozenRows(1);
  });
  var def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!leer_('Config').length) CONFIG_SEMILLA.forEach(function (r) { anexar_('Config', { Clave: r[0], Valor: r[1], Descripcion: r[2] }); });
  var cfg = config_();
  if (!cfg.CARPETA_ID) {
    var carpeta = DriveApp.createFolder('Honorarios Anestesia — Facturas y comprobantes');
    var fila = leer_('Config').filter(function (r) { return r.Clave === 'CARPETA_ID'; })[0];
    actualizar_('Config', fila._fila, { Valor: carpeta.getId() });
  }
  var existentes = leer_('Tabulador').map(function (r) { return r.Concepto_ID; });
  anexarVarios_('Tabulador', TABULADOR_SEMILLA.filter(function (t) { return existentes.indexOf(t[0]) < 0; }).map(function (t) {
    return { Concepto_ID: t[0], Categoria: t[1], Concepto: t[2], Nombre_Hoja_Costos: t[3], Tipo: t[4], Monto_Respaldo: t[5], Activo: 'Sí' };
  }));
  var claves = equivalencias_().map(function (e) { return e.clave; });
  var eqs = [];
  EQUIVALENCIAS_SEMILLA.forEach(function (e) {
    var k = norm(e[0]);
    if (claves.indexOf(k) < 0) { eqs.push({ Nombre_Agenda: e[0], Clave_Normal: k, Concepto_ID: e[1], Notas: e[2], Veces_Visto: 0 }); claves.push(k); }
  });
  anexarVarios_('Equivalencias', eqs);
  if (!leer_('Pagadores').length) anexarVarios_('Pagadores', PAGADORES_SEMILLA.map(function (p) {
    return { Pagador_ID: p[0], Nombre: p[1], Razon_Social: p[2], RFC: p[3], Patron_Sede: p[4], Pagan: p[5], Activo: p[6] };
  }));
  // Casos abiertos que aún no tienen pagador: se asigna por su sede.
  var pagsB = leer_('Pagadores');
  leer_('Casos').forEach(function (c) {
    if (!c.Pagador && ['Pagado', 'Excluido'].indexOf(c.Estado) < 0) {
      var pid = pagadorDeSede(c.Sede, pagsB);
      if (pid) actualizar_('Casos', c._fila, { Pagador: pid });
    }
  });
  if (!leer_('Usuarios').length) {
    anexar_('Usuarios', { Email: Session.getEffectiveUser().getEmail(), Nombre: 'Dr. Miguel Soto', Rol: 'admin', Activo: 'Sí' });
  }
  // Verifica que cada concepto encontró su monto en la hoja de costos.
  TAB_CACHE = null;
  var tab = tabulador_();
  var faltan = Object.keys(tab).filter(function (k) { return !tab[k].deHoja && !(tab[k].monto > 0) && tab[k].tipo !== 'No_cuenta'; });
  var msg = 'Listo: ' + ss.getUrl() + (faltan.length ? ' · SIN MONTO EN LA HOJA: ' + faltan.join(', ') : ' · tabulador completo');
  Logger.log(msg);
  return msg;
}

function instalarDisparador() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sincronizar') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sincronizar').timeBased().everyHours(1).create();
  return 'Sincronización cada hora instalada';
}

/* ===================== Sincronización con la agenda ===================== */

function eventosAgenda_(cfg) {
  var cal = CalendarApp.getCalendarById(cfg.CALENDARIO_ID);
  if (!cal) throw new Error('Sin acceso a la agenda ' + cfg.CALENDARIO_ID);
  var desde = new Date(Date.now() - Number(cfg.DIAS_ATRAS || 90) * 864e5);
  var hasta = new Date(Date.now() + Number(cfg.DIAS_ADELANTE || 30) * 864e5);
  return cal.getEvents(desde, hasta).map(function (e) {
    return { id: e.getId() + '@' + e.getStartTime().getTime(), summary: e.getTitle(), description: e.getDescription(), start: e.getStartTime(), status: '' };
  });
}

/** Núcleo de la sincronización, independiente de CalendarApp para poder probarlo. */
function planearSincronizacion(eventos, eqs, cfg, anest, ahora) {
  var excl = new RegExp(cfg.SEDES_EXCLUIDAS || 'angeles|pedregal|hap', 'i');
  var inicio = cfg.FECHA_INICIO ? new Date(cfg.FECHA_INICIO + 'T00:00:00-06:00') : null;
  var parsed = eventos.map(parsearEvento).filter(function (p) { return !inicio || p.tipo === 'vpa' || new Date(p.fecha) >= inicio; });
  var vpas = parsed.filter(function (p) { return p.tipo === 'vpa' && !p.cancelado; });
  var casos = [];
  parsed.forEach(function (p) {
    if (p.tipo === 'ignorar' || p.tipo === 'vpa') return;
    var motivoExcl = '';
    if (p.cancelado) motivoExcl = 'Cancelada en agenda';
    else if (p.asistencia === 'No') motivoExcl = 'No asistió';
    else if (norm(p.anestesia) === 'local') motivoExcl = 'Anestesia local';
    else if (excl.test(norm(p.sede))) motivoExcl = 'Sede con aseguradora (' + p.sede + ')';

    var lineas = [];
    if (p.tipo === 'estructurado') {
      if (!/general|sedaci/i.test(p.anestesia) && !motivoExcl) motivoExcl = 'Sin anestesia (' + (p.anestesia || 'no indicada') + ')';
      p.procedimientos.forEach(function (t) { lineas.push({ texto: t, concepto: mapearTexto(t, eqs) }); });
      if (!lineas.length) {
        // Sólo trae la cotización, sin nombre de procedimiento.
        if (/sedaci/i.test(p.anestesia)) lineas.push({ texto: 'Sedación' + (p.cot ? ' (' + p.cot + ')' : ''), concepto: 'S01' });
        else lineas.push({ texto: 'Procedimiento sin nombre' + (p.cot ? ' (' + p.cot + ')' : ''), concepto: '' });
      }
    } else {
      lineas = buscarEnTextoLibre(p.texto, eqs);
      var conAnest = /general|sedaci/i.test(p.anestesia);
      var hayProc = lineas.some(function (l) { return l.concepto && l.concepto !== 'NC'; });
      if (!conAnest && !hayProc && !motivoExcl) return; // nota de agenda sin procedimiento anestésico: no es caso
      if (!lineas.length && /sedaci/i.test(p.anestesia)) lineas.push({ texto: 'Sedación', concepto: 'S01' });
      if (!lineas.length) lineas.push({ texto: p.texto || p.titulo, concepto: '' });
    }
    // Empatar VPA: misma cotización, o mismo paciente con VPA hasta 30 días antes.
    var fecha = new Date(p.fecha);
    var vpa = null;
    vpas.forEach(function (v) {
      var fv = new Date(v.fecha);
      var mismo = (p.cot && v.cot && p.cot === v.cot) || norm(v.paciente) === norm(p.paciente);
      if (mismo && fv <= fecha && (fecha - fv) <= 30 * 864e5) vpa = v;
    });
    var operativo = vpa ? vpa.operativo : '';
    var email = '';
    anest.forEach(function (a) { if (a.Activo !== 'No' && operativo && norm(a.Nombre_Agenda) && norm(operativo) === norm(a.Nombre_Agenda)) email = a.Email; });
    if (!email && cfg.ANESTESIOLOGO_DEFAULT) email = cfg.ANESTESIOLOGO_DEFAULT;
    casos.push({
      eventoId: p.id, vpaEventoId: vpa ? vpa.id : '', fecha: fecha, paciente: p.paciente, cot: p.cot,
      sede: p.sede, pagador: pagadorDeSede(p.sede, cfg._pagadores || []), anestesia: p.anestesia, texto: p.texto, origen: p.tipo === 'estructurado' ? 'Agenda' : 'Agenda (texto libre)',
      anestesiologo: email, vpaAgenda: vpa ? (vpa.asistencia || 'Sin marcar') : 'Sin VPA',
      estado: motivoExcl ? 'Excluido' : (fecha > ahora ? 'Programado' : 'Por_confirmar'),
      motivo: motivoExcl, lineas: lineas
    });
  });
  return casos;
}

function sincronizar() {
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  LOCK_TOMADO = true;
  try {
    var cfg = config_(), tab = tabulador_(), eqs = equivalencias_();
    cfg._pagadores = leer_('Pagadores');
    var anest = leer_('Anestesiologos');
    var plan = planearSincronizacion(eventosAgenda_(cfg), eqs, cfg, anest, new Date());
    var existentes = {};
    leer_('Casos').forEach(function (c) { existentes[c.Evento_ID] = c; });
    var lineasTodas = leer_('Lineas');
    var nuevos = 0, actualizados = 0;
    if (cfg.FECHA_INICIO) {
      Object.keys(existentes).forEach(function (k) {
        var ex = existentes[k];
        if (String(ex.Fecha_Cirugia instanceof Date ? Utilities.formatDate(ex.Fecha_Cirugia, TZ, 'yyyy-MM-dd') : ex.Fecha_Cirugia).slice(0, 10) < cfg.FECHA_INICIO &&
            ['Programado', 'Por_confirmar'].indexOf(ex.Estado) >= 0) {
          actualizar_('Casos', ex._fila, { Estado: 'Excluido', Motivo: 'Anterior al arranque de la app (' + cfg.FECHA_INICIO + ')', Actualizado_En: ahora_() });
          ex.Estado = 'Excluido';
        }
      });
    }
    var vistos = {};
    var casosNuevos = [], lineasNuevas = [];
    plan.forEach(function (c) {
      c.lineas.forEach(function (l) { var k = norm(l.texto); vistos[k] = (vistos[k] || 0) + 1; });
      var ex = existentes[c.eventoId];
      if (!ex) {
        if (c.estado === 'Excluido' && /Cancelada|No asisti/.test(c.motivo)) return; // no ensuciar con canceladas nuevas
        var id = folio_('ANE');
        var vpaCobra = c.vpaAgenda === 'Sí';
        c.lineas.forEach(function (l) {
          lineasNuevas.push({ Linea_ID: folio_('LIN'), Caso_ID: id, Origen: 'Agenda', Texto: l.texto, Concepto_ID: l.concepto, Activa: 'Sí', Agregado_Por: 'agenda', Agregado_En: ahora_() });
        });
        var r = calcular(c.lineas.map(function (l) { return { concepto: l.concepto, activa: true }; }), tab, { externos: 0, vpa: vpaCobra, reintervencion: false });
        casosNuevos.push({
          Caso_ID: id, Evento_ID: c.eventoId, VPA_Evento_ID: c.vpaEventoId,
          Fecha_Cirugia: Utilities.formatDate(c.fecha, TZ, 'yyyy-MM-dd HH:mm'), Paciente: c.paciente, COT: c.cot,
          Sede: c.sede, Pagador: c.pagador, Tipo_Anestesia: c.anestesia, Texto_Agenda: c.texto, Origen: c.origen,
          Anestesiologo_Email: c.anestesiologo, Estado: c.estado, VPA_Agenda: c.vpaAgenda,
          VPA_Cobra: vpaCobra ? 'Sí' : 'No', Medicos_Externos: 0, Reintervencion: 'No',
          Base_Concepto: r.baseConcepto, Base_Monto: r.baseMonto, Adicionales_N: r.adicionalesN,
          Adicionales_Monto: r.adicionalesMonto, Externos_Monto: r.externosMonto, VPA_Monto: r.vpaMonto,
          Total: r.total, Sin_Mapear: r.sinMapear,
          Motivo: c.motivo, Creado_En: ahora_(), Actualizado_En: ahora_()
        });
        nuevos++;
      } else if (['Programado', 'Por_confirmar'].indexOf(ex.Estado) >= 0) {
        var cambios = { VPA_Agenda: c.vpaAgenda, VPA_Evento_ID: c.vpaEventoId, Actualizado_En: ahora_() };
        if (c.sede && String(c.sede) !== String(ex.Sede)) cambios.Sede = c.sede;
        // El pagador sigue a la sede mientras nadie lo haya fijado a mano.
        if (c.pagador && (!ex.Pagador || (cambios.Sede && String(ex.Pagador) === String(pagadorDeSede(ex.Sede, cfg._pagadores))))) cambios.Pagador = c.pagador;
        if (!ex.Anestesiologo_Email && c.anestesiologo) cambios.Anestesiologo_Email = c.anestesiologo;
        if (c.estado === 'Excluido') { cambios.Estado = 'Excluido'; cambios.Motivo = c.motivo; }
        else if (ex.Estado === 'Programado' && c.estado === 'Por_confirmar') cambios.Estado = 'Por_confirmar';
        if (c.vpaAgenda === 'Sí' && ex.VPA_Agenda !== 'Sí') cambios.VPA_Cobra = 'Sí';
        // Si la agenda cambió el procedimiento y nadie ha tocado el caso, se rehacen las líneas de agenda.
        if (String(ex.Texto_Agenda) !== String(c.texto)) {
          var propias = lineasTodas.filter(function (l) { return l.Caso_ID === ex.Caso_ID; });
          if (!propias.some(function (l) { return l.Origen !== 'Agenda'; })) {
            propias.forEach(function (l) { actualizar_('Lineas', l._fila, { Activa: 'No' }); });
            c.lineas.forEach(function (l) {
              anexar_('Lineas', { Linea_ID: folio_('LIN'), Caso_ID: ex.Caso_ID, Origen: 'Agenda', Texto: l.texto, Concepto_ID: l.concepto, Activa: 'Sí', Agregado_Por: 'agenda', Agregado_En: ahora_() });
            });
            cambios.Texto_Agenda = c.texto;
          }
        }
        var relevante = Object.keys(cambios).some(function (k) { return k !== 'Actualizado_En' && String(cambios[k]) !== String(ex[k]); });
        if (relevante) {
          actualizar_('Casos', ex._fila, cambios);
          recalcular_(ex.Caso_ID, tab);
          actualizados++;
        }
      }
    });
    anexarVarios_('Lineas', lineasNuevas);
    anexarVarios_('Casos', casosNuevos);
    // Contador de uso de cada nombre y alta de nombres nuevos sin mapear en Equivalencias.
    var claves = {};
    eqs.forEach(function (e) { claves[e.clave] = e; });
    Object.keys(vistos).forEach(function (k) {
      if (!k) return;
      if (claves[k] && claves[k]._fila && Number(claves[k].veces) !== vistos[k]) actualizar_('Equivalencias', claves[k]._fila, { Veces_Visto: vistos[k], Ultima_Vez: ahora_() });
    });
    var eqNuevas = [];
    plan.forEach(function (c) {
      if (c.origen !== 'Agenda') return;
      c.lineas.forEach(function (l) {
        var k = norm(l.texto);
        if (!l.concepto && k && !claves[k]) {
          eqNuevas.push({ Nombre_Agenda: l.texto, Clave_Normal: k, Concepto_ID: '', Notas: 'nuevo: sin mapear', Veces_Visto: vistos[k], Ultima_Vez: ahora_() });
          claves[k] = { clave: k };
        }
      });
    });
    anexarVarios_('Equivalencias', eqNuevas);
    PROP.setProperty('ULTIMA_SINC', ahora_());
    var res = { nuevos: nuevos, actualizados: actualizados, total: plan.length };
    Logger.log(JSON.stringify(res));
    return res;
  } finally { LOCK_TOMADO = false; lock.releaseLock(); }
}

/* ===================== Cálculo y estado de un caso ===================== */

function recalcular_(casoId, tab) {
  tab = tab || tabulador_();
  var caso = leer_('Casos').filter(function (c) { return c.Caso_ID === casoId; })[0];
  if (!caso) throw new Error('Caso no encontrado');
  var lineas = leer_('Lineas').filter(function (l) { return l.Caso_ID === casoId; }).map(function (l) {
    return { concepto: l.Concepto_ID, activa: l.Activa !== 'No' };
  });
  var r = calcular(lineas, tab, { externos: caso.Medicos_Externos, vpa: caso.VPA_Cobra === 'Sí', reintervencion: caso.Reintervencion === 'Sí' });
  actualizar_('Casos', caso._fila, {
    Base_Concepto: r.baseConcepto, Base_Monto: r.baseMonto, Adicionales_N: r.adicionalesN,
    Adicionales_Monto: r.adicionalesMonto, Externos_Monto: r.externosMonto, VPA_Monto: r.vpaMonto,
    Total: r.total, Sin_Mapear: r.sinMapear, Actualizado_En: ahora_()
  });
  return r;
}

/* ===================== Identidad ===================== */

function autenticar_(idToken) {
  if (!idToken) throw new Error('Sin sesión');
  var cache = CacheService.getScriptCache();
  var hit = cache.get('tok_' + idToken.slice(-40));
  var info;
  if (hit) info = JSON.parse(hit);
  else {
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Sesión inválida o vencida');
    info = JSON.parse(res.getContentText());
    cache.put('tok_' + idToken.slice(-40), JSON.stringify(info), 600);
  }
  var cfg = config_();
  if (!cfg.OAUTH_CLIENT_ID || info.aud !== cfg.OAUTH_CLIENT_ID) throw new Error('Token emitido para otra aplicación');
  if (String(info.email_verified) !== 'true') throw new Error('Correo no verificado');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('Sesión vencida');
  var email = String(info.email).toLowerCase();
  var roles = [];
  var nombre = info.name || email;
  leer_('Usuarios').forEach(function (u) {
    if (String(u.Email).toLowerCase() === email && u.Activo !== 'No') {
      String(u.Rol).split(/[,\s]+/).forEach(function (r) { if (r) roles.push(r.toLowerCase()); });
      nombre = u.Nombre || nombre;
    }
  });
  var paga = [];
  if (roles.indexOf('admin') >= 0) { roles.push('aprobador', 'pagador'); paga = ['*']; }
  else leer_('Pagadores').forEach(function (p) {
    if (p.Activo === 'No') return;
    var lista = String(p.Pagan || '').toLowerCase().split(/[,;\s]+/);
    if (lista.indexOf(email) >= 0) paga.push(p.Pagador_ID);
  });
  if (paga.length && roles.indexOf('pagador') < 0) roles.push('pagador');
  if (!paga.length) roles = roles.filter(function (r) { return r !== 'pagador'; });
  var a = leer_('Anestesiologos').filter(function (x) { return String(x.Email).toLowerCase() === email && x.Activo !== 'No'; })[0];
  if (a) { roles.push('anestesiologo'); nombre = a.Nombre || nombre; }
  if (!roles.length) throw new Error('Tu cuenta (' + email + ') no tiene acceso. Pide que te den de alta.');
  return { email: email, nombre: nombre, roles: roles, paga: paga };
}

/** ¿Este usuario registra pagos de ese pagador? */
function pagaA_(u, pagadorId) { return (u.paga || []).indexOf('*') >= 0 || (u.paga || []).indexOf(pagadorId) >= 0; }
function pagadoresMapa_() { var m = {}; leer_('Pagadores').forEach(function (p) { m[p.Pagador_ID] = p; }); return m; }

function exigir_(u, rol) { if (u.roles.indexOf(rol) < 0) throw new Error('Sin permiso para esta acción'); }
function tiene_(u, rol) { return u.roles.indexOf(rol) >= 0; }

/* ===================== API ===================== */

function doGet(e) {
  return salida_({ ok: true, servicio: 'Honorarios Anestesia', version: VERSION });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var u = autenticar_(req.idToken);
    var fn = ACCIONES[req.accion];
    if (!fn) throw new Error('Acción desconocida: ' + req.accion);
    return salida_({ ok: true, data: fn(u, req.datos || {}) });
  } catch (err) {
    return salida_({ ok: false, error: String(err.message || err) });
  }
}

function salida_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function casoConLineas_(caso) {
  var tab = tabulador_();
  var lineas = leer_('Lineas').filter(function (l) { return l.Caso_ID === caso.Caso_ID; }).map(function (l) {
    var c = tab[l.Concepto_ID];
    return { id: l.Linea_ID, origen: l.Origen, texto: l.Texto, concepto: l.Concepto_ID, conceptoNombre: c ? c.concepto : '', monto: c ? c.monto : null, tipo: c ? c.tipo : '', activa: l.Activa !== 'No', por: l.Agregado_Por };
  });
  return { caso: limpio_(caso), lineas: lineas };
}

function limpio_(o) { var r = {}; Object.keys(o).forEach(function (k) { if (k !== '_fila') r[k] = o[k] instanceof Date ? Utilities.formatDate(o[k], TZ, 'yyyy-MM-dd HH:mm') : o[k]; }); return r; }

function obtenerCaso_(id) {
  var c = leer_('Casos').filter(function (x) { return x.Caso_ID === id; })[0];
  if (!c) throw new Error('Caso no encontrado');
  return c;
}

function puedeVer_(u, c) {
  if (tiene_(u, 'aprobador')) return true;
  if (tiene_(u, 'pagador') && pagaA_(u, c.Pagador)) return true;
  return tiene_(u, 'anestesiologo') && (String(c.Anestesiologo_Email).toLowerCase() === u.email || !c.Anestesiologo_Email);
}

function editablePorAnest_(u, c) {
  return tiene_(u, 'anestesiologo') && String(c.Anestesiologo_Email).toLowerCase() === u.email && c.Estado === 'Por_confirmar';
}

function editablePorAprob_(u, c) {
  return tiene_(u, 'aprobador') && ['Programado', 'Por_confirmar', 'Por_aprobar', 'Rechazado', 'Excluido'].indexOf(c.Estado) >= 0;
}

var ACCIONES = {
  sesion: function (u) {
    return { email: u.email, nombre: u.nombre, roles: u.roles, paga: u.paga, ultimaSinc: PROP.getProperty('ULTIMA_SINC') || '', version: VERSION };
  },

  catalogo: function (u) {
    var tab = tabulador_();
    var out = Object.keys(tab).map(function (k) { return { id: k, concepto: tab[k].concepto, monto: tab[k].monto, tipo: tab[k].tipo, categoria: tab[k].categoria, deHoja: tab[k].deHoja }; });
    var anest = tiene_(u, 'aprobador') ? leer_('Anestesiologos').filter(function (a) { return a.Activo !== 'No'; }).map(function (a) { return { email: a.Email, nombre: a.Nombre }; }) : [];
    var pags = leer_('Pagadores').filter(function (p) { return p.Activo !== 'No'; }).map(function (p) { return { id: p.Pagador_ID, nombre: p.Nombre, razon: p.Razon_Social, rfc: p.RFC }; });
    return { tabulador: out, anestesiologos: anest, pagadores: pags };
  },

  casos: function (u, d) {
    var todos = leer_('Casos');
    var vis = todos.filter(function (c) { return puedeVer_(u, c); });
    if (!tiene_(u, 'aprobador') && !tiene_(u, 'pagador')) {
      vis = vis.filter(function (c) { return c.Estado !== 'Excluido' && (c.Anestesiologo_Email || c.Estado === 'Por_confirmar'); });
    }
    if (d.estado) vis = vis.filter(function (c) { return c.Estado === d.estado; });
    // Se ordena DESPUÉS de limpio_: Sheets guarda la fecha como Date y String(Date) ordenaría por nombre del día.
    var out = vis.map(limpio_);
    out.sort(function (a, b) { return String(b.Fecha_Cirugia).localeCompare(String(a.Fecha_Cirugia)); });
    return out.slice(0, d.limite || 400);
  },

  caso: function (u, d) {
    var c = obtenerCaso_(d.id);
    if (!puedeVer_(u, c)) throw new Error('Sin acceso a este caso');
    return casoConLineas_(c);
  },

  reclamar: function (u, d) {
    exigir_(u, 'anestesiologo');
    var c = obtenerCaso_(d.id);
    if (c.Anestesiologo_Email) throw new Error('Este caso ya tiene anestesiólogo');
    actualizar_('Casos', c._fila, { Anestesiologo_Email: u.email, Actualizado_En: ahora_() });
    bitacora_(u.email, 'reclamar', c.Caso_ID, '');
    return casoConLineas_(obtenerCaso_(d.id));
  },

  agregarLinea: function (u, d) {
    var c = obtenerCaso_(d.id);
    if (!editablePorAnest_(u, c) && !editablePorAprob_(u, c)) throw new Error('El caso no se puede modificar en este estado');
    var tab = tabulador_();
    var t = tab[d.concepto];
    if (!t || (t.tipo !== 'Procedimiento' && t.tipo !== 'Sedacion')) throw new Error('Elige un procedimiento del tabulador');
    anexar_('Lineas', { Linea_ID: folio_('LIN'), Caso_ID: c.Caso_ID, Origen: tiene_(u, 'aprobador') && !editablePorAnest_(u, c) ? 'Aprobador' : 'Anestesiologo', Texto: t.concepto, Concepto_ID: d.concepto, Activa: 'Sí', Agregado_Por: u.email, Agregado_En: ahora_() });
    recalcular_(c.Caso_ID, tab);
    bitacora_(u.email, 'agregarLinea', c.Caso_ID, d.concepto);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  quitarLinea: function (u, d) {
    var c = obtenerCaso_(d.id);
    var l = leer_('Lineas').filter(function (x) { return x.Linea_ID === d.linea && x.Caso_ID === c.Caso_ID; })[0];
    if (!l) throw new Error('Línea no encontrada');
    var okAnest = editablePorAnest_(u, c) && l.Origen === 'Anestesiologo' && String(l.Agregado_Por).toLowerCase() === u.email;
    if (!okAnest && !editablePorAprob_(u, c)) throw new Error('Sólo puedes quitar lo que tú agregaste; lo de la agenda no se modifica');
    actualizar_('Lineas', l._fila, { Activa: l.Activa === 'No' ? 'Sí' : 'No' });
    recalcular_(c.Caso_ID);
    bitacora_(u.email, 'quitarLinea', c.Caso_ID, d.linea);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  mapearLinea: function (u, d) {
    exigir_(u, 'aprobador');
    var c = obtenerCaso_(d.id);
    var l = leer_('Lineas').filter(function (x) { return x.Linea_ID === d.linea && x.Caso_ID === c.Caso_ID; })[0];
    if (!l) throw new Error('Línea no encontrada');
    var tab = tabulador_();
    if (!tab[d.concepto]) throw new Error('Concepto inválido');
    actualizar_('Lineas', l._fila, { Concepto_ID: d.concepto });
    if (d.guardar && c.Origen === 'Agenda') guardarEquivalencia_(u, l.Texto, d.concepto);
    recalcular_(c.Caso_ID, tab);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  marcar: function (u, d) {
    var c = obtenerCaso_(d.id);
    var esAprob = editablePorAprob_(u, c);
    if (!editablePorAnest_(u, c) && !esAprob) throw new Error('El caso no se puede modificar en este estado');
    var cambios = { Actualizado_En: ahora_() };
    if (d.externos !== undefined) cambios.Medicos_Externos = Math.max(0, Math.min(5, parseInt(d.externos, 10) || 0));
    if (d.vpa !== undefined) {
      if (d.vpa && c.VPA_Agenda === 'Sin VPA' && !esAprob) throw new Error('No hay VPA en la agenda para esta paciente; la tiene que validar el aprobador');
      cambios.VPA_Cobra = d.vpa ? 'Sí' : 'No';
    }
    if (d.reintervencion !== undefined) { cambios.Reintervencion = d.reintervencion ? 'Sí' : 'No'; cambios.Reintervencion_Ref = d.reintervencionRef || ''; }
    if (d.anestesiologo !== undefined) { exigir_(u, 'aprobador'); cambios.Anestesiologo_Email = d.anestesiologo; }
    if (d.pagador !== undefined) {
      exigir_(u, 'aprobador');
      if (d.pagador && !pagadoresMapa_()[d.pagador]) throw new Error('Pagador inválido');
      cambios.Pagador = d.pagador;
    }
    actualizar_('Casos', c._fila, cambios);
    recalcular_(c.Caso_ID);
    bitacora_(u.email, 'marcar', c.Caso_ID, d);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  confirmar: function (u, d) {
    var c = obtenerCaso_(d.id);
    if (!editablePorAnest_(u, c)) throw new Error('Sólo el anestesiólogo del caso puede confirmarlo, y sólo después de la cirugía');
    if (Number(c.Sin_Mapear) > 0) throw new Error('Hay procedimientos sin clasificar; el aprobador los tiene que mapear primero');
    actualizar_('Casos', c._fila, { Estado: 'Por_aprobar', Confirmado_En: ahora_(), Motivo: '' });
    bitacora_(u.email, 'confirmar', c.Caso_ID, c.Total);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  aprobar: function (u, d) {
    exigir_(u, 'aprobador');
    var c = obtenerCaso_(d.id);
    if (['Por_aprobar', 'Por_confirmar'].indexOf(c.Estado) < 0) throw new Error('Este caso no está pendiente de aprobación');
    if (!c.Anestesiologo_Email) throw new Error('Asigna al anestesiólogo antes de aprobar');
    if (!c.Pagador) throw new Error('Elige quién paga este caso (Zorvix o Renasté) antes de aprobar');
    if (Number(c.Sin_Mapear) > 0) throw new Error('Clasifica los procedimientos sin mapear antes de aprobar');
    if (!(Number(c.Total) > 0)) throw new Error('El caso tiene total en cero');
    recalcular_(c.Caso_ID);
    c = obtenerCaso_(d.id);
    actualizar_('Casos', c._fila, { Estado: 'Aprobado', Aprobado_Por: u.email, Aprobado_En: ahora_(), Motivo: '' });
    bitacora_(u.email, 'aprobar', c.Caso_ID, c.Total);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  rechazar: function (u, d) {
    exigir_(u, 'aprobador');
    var c = obtenerCaso_(d.id);
    if (!d.motivo) throw new Error('Escribe el motivo');
    var nuevo = d.excluir ? 'Excluido' : 'Por_confirmar';
    if (['Aprobado', 'En_cobro', 'Pagado'].indexOf(c.Estado) >= 0 && c.Estado !== 'Aprobado') throw new Error('El caso ya está en cobro o pagado');
    actualizar_('Casos', c._fila, { Estado: nuevo, Motivo: d.motivo, Actualizado_En: ahora_() });
    bitacora_(u.email, d.excluir ? 'excluir' : 'regresar', c.Caso_ID, d.motivo);
    return casoConLineas_(obtenerCaso_(d.id));
  },

  reabrir: function (u, d) {
    exigir_(u, 'aprobador');
    var c = obtenerCaso_(d.id);
    if (c.Estado !== 'Excluido') throw new Error('Sólo se reabren casos excluidos');
    actualizar_('Casos', c._fila, { Estado: 'Por_confirmar', Motivo: '', Actualizado_En: ahora_() });
    recalcular_(c.Caso_ID);
    bitacora_(u.email, 'reabrir', c.Caso_ID, '');
    return casoConLineas_(obtenerCaso_(d.id));
  },

  equivalencias: function (u) {
    exigir_(u, 'aprobador');
    return leer_('Equivalencias').map(limpio_);
  },

  guardarEquivalencia: function (u, d) {
    exigir_(u, 'aprobador');
    guardarEquivalencia_(u, d.nombre, d.concepto);
    return leer_('Equivalencias').map(limpio_);
  },

  crearSolicitud: function (u, d) {
    exigir_(u, 'anestesiologo');
    var cfg = config_();
    var ids = d.casos || [];
    if (!ids.length) throw new Error('Elige al menos un caso aprobado');
    if (!d.xml) throw new Error('Falta el XML de la factura');
    var casos = leer_('Casos').filter(function (c) { return ids.indexOf(c.Caso_ID) >= 0; });
    if (casos.length !== ids.length) throw new Error('Algún caso no existe');
    casos.forEach(function (c) {
      if (String(c.Anestesiologo_Email).toLowerCase() !== u.email) throw new Error('El caso ' + c.Caso_ID + ' no es tuyo');
      if (c.Estado !== 'Aprobado') throw new Error('El caso ' + c.Caso_ID + ' no está aprobado');
    });
    var pagId = casos[0].Pagador;
    if (casos.some(function (c) { return c.Pagador !== pagId; })) throw new Error('Una factura sólo puede llevar casos de un mismo pagador: separa Zorvix y Renasté');
    var pag = pagadoresMapa_()[pagId];
    if (!pag) throw new Error('El caso ' + casos[0].Caso_ID + ' no tiene pagador asignado; avisa al Dr. Soto');
    var rfcRec = String(pag.RFC || '').trim().toUpperCase();
    if (!rfcRec) throw new Error('Todavía no está registrado el RFC de ' + pag.Nombre + '; avisa al Dr. Soto');
    var suma = casos.reduce(function (s, c) { return s + Number(c.Total); }, 0);
    var xml = Utilities.newBlob(Utilities.base64Decode(d.xml)).getDataAsString('UTF-8');
    var f = leerCFDI(xml);
    var errores = [];
    if (!f.uuid) errores.push('El XML no trae timbre fiscal (UUID)');
    if (f.tipo && f.tipo !== 'I') errores.push('El CFDI no es de ingreso (tipo ' + f.tipo + ')');
    if (f.rfcReceptor !== rfcRec) errores.push('La factura está a nombre del RFC ' + f.rfcReceptor + '; para estos casos debe ser ' + rfcRec + ' (' + (pag.Razon_Social || pag.Nombre) + ')');
    var a = leer_('Anestesiologos').filter(function (x) { return String(x.Email).toLowerCase() === u.email; })[0];
    if (a && a.RFC && f.rfcEmisor !== String(a.RFC).toUpperCase()) errores.push('El emisor ' + f.rfcEmisor + ' no coincide con tu RFC registrado');
    var tol = Number(cfg.TOLERANCIA_PESOS || 1);
    if (Math.abs(Number(f.total) - suma) > tol) errores.push('El total de la factura ($' + Number(f.total).toFixed(2) + ') no coincide con lo aprobado ($' + suma.toFixed(2) + ')');
    if (leer_('Solicitudes').some(function (s) { return String(s.UUID).toUpperCase() === f.uuid && s.Estado !== 'Rechazada'; })) errores.push('Esa factura (UUID ' + f.uuid + ') ya se presentó');
    if (errores.length) throw new Error(errores.join(' · '));
    var sat = consultarSAT_(f);
    if (sat === 'Cancelado') throw new Error('El SAT reporta esa factura como CANCELADA');
    var carpeta = DriveApp.getFolderById(cfg.CARPETA_ID);
    var solId = folio_('SOL');
    var xmlFile = carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(d.xml), 'application/xml', solId + '_' + f.uuid + '.xml'));
    var pdfId = '';
    if (d.pdf) pdfId = carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(d.pdf), 'application/pdf', solId + '_' + f.uuid + '.pdf')).getId();
    anexar_('Solicitudes', {
      Solicitud_ID: solId, Anestesiologo_Email: u.email, Casos: ids.join(','), Total_Casos: suma, UUID: f.uuid,
      RFC_Emisor: f.rfcEmisor, RFC_Receptor: f.rfcReceptor, Total_CFDI: Number(f.total), Fecha_CFDI: f.fecha,
      Estado_SAT: sat, XML_ID: xmlFile.getId(), PDF_ID: pdfId, Estado: 'Por_pagar', Creado_En: ahora_(), Pagador: pagId
    });
    casos.forEach(function (c) { actualizar_('Casos', c._fila, { Estado: 'En_cobro', Solicitud_ID: solId, Actualizado_En: ahora_() }); });
    bitacora_(u.email, 'crearSolicitud', solId, { casos: ids, total: suma, uuid: f.uuid, sat: sat });
    return { solicitud: solId, total: suma, uuid: f.uuid, estadoSAT: sat };
  },

  solicitudes: function (u, d) {
    var todas = leer_('Solicitudes');
    if (!tiene_(u, 'aprobador')) todas = todas.filter(function (s) { return String(s.Anestesiologo_Email).toLowerCase() === u.email || (tiene_(u, 'pagador') && pagaA_(u, s.Pagador)); });
    var pags = pagadoresMapa_();
    if (d.estado) todas = todas.filter(function (s) { return s.Estado === d.estado; });
    var anest = {};
    leer_('Anestesiologos').forEach(function (a) { anest[String(a.Email).toLowerCase()] = a; });
    var verBanco = function (s) { return tiene_(u, 'pagador') && pagaA_(u, s.Pagador); };
    todas = todas.map(function (s) { var o = limpio_(s); o._orig = s; return o; });
    todas.sort(function (a, b) { return String(b.Creado_En).localeCompare(String(a.Creado_En)); });
    return todas.map(function (o) {
      var s = o._orig; delete o._orig;
      var a = anest[String(s.Anestesiologo_Email).toLowerCase()] || {};
      o.Anestesiologo = a.Nombre || s.Anestesiologo_Email;
      var pg = pags[s.Pagador] || {};
      o.Pagador_Nombre = pg.Nombre || (s.Pagador || '—');
      o.Puedo_Pagar = verBanco(s);
      if (verBanco(s)) { o.Banco = a.Banco || ''; o.CLABE = a.CLABE || ''; }
      o.XML_URL = s.XML_ID ? 'https://drive.google.com/file/d/' + s.XML_ID + '/view' : '';
      o.PDF_URL = s.PDF_ID ? 'https://drive.google.com/file/d/' + s.PDF_ID + '/view' : '';
      o.Comprobante_URL = s.Comprobante_ID ? 'https://drive.google.com/file/d/' + s.Comprobante_ID + '/view' : '';
      return o;
    });
  },

  marcarPagada: function (u, d) {
    exigir_(u, 'pagador');
    var s = leer_('Solicitudes').filter(function (x) { return x.Solicitud_ID === d.id; })[0];
    if (!s) throw new Error('Solicitud no encontrada');
    if (s.Estado !== 'Por_pagar') throw new Error('La solicitud no está por pagar');
    if (!pagaA_(u, s.Pagador)) throw new Error('Esta factura la paga otra razón social');
    if (!d.comprobante) throw new Error('Sube el comprobante de la transferencia');
    var cfg = config_();
    var ext = /pdf/i.test(d.tipo || '') ? 'pdf' : (/png/i.test(d.tipo || '') ? 'png' : 'jpg');
    var archivo = DriveApp.getFolderById(cfg.CARPETA_ID).createFile(Utilities.newBlob(Utilities.base64Decode(d.comprobante), d.tipo || 'application/octet-stream', s.Solicitud_ID + '_comprobante.' + ext));
    actualizar_('Solicitudes', s._fila, { Estado: 'Pagada', Comprobante_ID: archivo.getId(), Referencia_Pago: d.referencia || '', Pagado_Por: u.email, Pagado_En: ahora_() });
    var ids = String(s.Casos).split(',');
    leer_('Casos').forEach(function (c) { if (ids.indexOf(c.Caso_ID) >= 0) actualizar_('Casos', c._fila, { Estado: 'Pagado', Actualizado_En: ahora_() }); });
    bitacora_(u.email, 'marcarPagada', s.Solicitud_ID, d.referencia || '');
    return { ok: true };
  },

  rechazarSolicitud: function (u, d) {
    exigir_(u, 'pagador');
    var s = leer_('Solicitudes').filter(function (x) { return x.Solicitud_ID === d.id; })[0];
    if (!s || s.Estado !== 'Por_pagar') throw new Error('La solicitud no está por pagar');
    if (!pagaA_(u, s.Pagador)) throw new Error('Esta factura la paga otra razón social');
    if (!d.motivo) throw new Error('Escribe el motivo');
    actualizar_('Solicitudes', s._fila, { Estado: 'Rechazada', Motivo: d.motivo });
    var ids = String(s.Casos).split(',');
    leer_('Casos').forEach(function (c) { if (ids.indexOf(c.Caso_ID) >= 0) actualizar_('Casos', c._fila, { Estado: 'Aprobado', Solicitud_ID: '', Actualizado_En: ahora_() }); });
    bitacora_(u.email, 'rechazarSolicitud', s.Solicitud_ID, d.motivo);
    return { ok: true };
  },

  tablero: function (u) {
    var casos = leer_('Casos');
    if (!tiene_(u, 'aprobador')) casos = casos.filter(function (c) { return String(c.Anestesiologo_Email).toLowerCase() === u.email || (tiene_(u, 'pagador') && pagaA_(u, c.Pagador)); });
    var pags = pagadoresMapa_();
    var porPagador = {};
    var anest = {};
    leer_('Anestesiologos').forEach(function (a) { anest[String(a.Email).toLowerCase()] = a.Nombre; });
    var porEstado = {}, porMes = {}, porAnest = {};
    casos.forEach(function (c) {
      if (c.Estado === 'Excluido') return;
      var t = Number(c.Total) || 0;
      var pn = (pags[c.Pagador] || {}).Nombre || 'Sin definir';
      porPagador[pn] = porPagador[pn] || { pendiente: 0, pagado: 0 };
      if (c.Estado === 'Pagado') porPagador[pn].pagado += t;
      else if (['Por_confirmar', 'Por_aprobar', 'Aprobado', 'En_cobro'].indexOf(c.Estado) >= 0) porPagador[pn].pendiente += t;
      porEstado[c.Estado] = porEstado[c.Estado] || { n: 0, total: 0 };
      porEstado[c.Estado].n++; porEstado[c.Estado].total += t;
      var mes = String(c.Fecha_Cirugia instanceof Date ? Utilities.formatDate(c.Fecha_Cirugia, TZ, 'yyyy-MM') : c.Fecha_Cirugia).slice(0, 7);
      var nom = anest[String(c.Anestesiologo_Email).toLowerCase()] || (c.Anestesiologo_Email || 'Sin asignar');
      if (c.Estado === 'Pagado') {
        porMes[mes] = (porMes[mes] || 0) + t;
        porAnest[nom] = porAnest[nom] || { pagado: 0, pendiente: 0 };
        porAnest[nom].pagado += t;
      } else if (['Por_confirmar', 'Por_aprobar', 'Aprobado', 'En_cobro'].indexOf(c.Estado) >= 0) {
        porAnest[nom] = porAnest[nom] || { pagado: 0, pendiente: 0 };
        porAnest[nom].pendiente += t;
      }
    });
    return { porEstado: porEstado, porMes: porMes, porAnest: porAnest, porPagador: porPagador, ultimaSinc: PROP.getProperty('ULTIMA_SINC') || '' };
  },

  sincronizarAhora: function (u) {
    exigir_(u, 'aprobador');
    return sincronizar();
  }
};

function guardarEquivalencia_(u, nombre, concepto) {
  var k = norm(nombre);
  if (!k) throw new Error('Nombre vacío');
  var ex = equivalencias_().filter(function (e) { return e.clave === k; })[0];
  if (ex) actualizar_('Equivalencias', ex._fila, { Concepto_ID: concepto, Notas: 'mapeado por ' + u.email });
  else anexar_('Equivalencias', { Nombre_Agenda: nombre, Clave_Normal: k, Concepto_ID: concepto, Notas: 'mapeado por ' + u.email, Veces_Visto: 0, Ultima_Vez: ahora_() });
  // Aplica el nuevo mapeo a líneas de agenda abiertas con ese mismo nombre.
  var abiertos = {};
  leer_('Casos').forEach(function (c) { if (['Programado', 'Por_confirmar', 'Por_aprobar'].indexOf(c.Estado) >= 0) abiertos[c.Caso_ID] = true; });
  var tocados = {};
  leer_('Lineas').forEach(function (l) {
    if (abiertos[l.Caso_ID] && l.Origen === 'Agenda' && !l.Concepto_ID && norm(l.Texto) === k) {
      actualizar_('Lineas', l._fila, { Concepto_ID: concepto }); tocados[l.Caso_ID] = true;
    }
  });
  var tab = tabulador_();
  Object.keys(tocados).forEach(function (id) { recalcular_(id, tab); });
  bitacora_(u.email, 'equivalencia', nombre, concepto);
}

/** Consulta de estatus de CFDI en el servicio público del SAT. */
function consultarSAT_(f) {
  try {
    var expr = '?re=' + f.rfcEmisor + '&rr=' + f.rfcReceptor + '&tt=' + f.total + '&id=' + f.uuid;
    var cuerpo = '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><soap:Body><tem:Consulta><tem:expresionImpresa><![CDATA[' + expr + ']]></tem:expresionImpresa></tem:Consulta></soap:Body></soap:Envelope>';
    var res = UrlFetchApp.fetch('https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc', {
      method: 'post', contentType: 'text/xml; charset=utf-8', payload: cuerpo,
      headers: { SOAPAction: 'http://tempuri.org/IConsultaCFDIService/Consulta' }, muteHttpExceptions: true
    });
    var m = res.getContentText().match(/<a:Estado>([^<]*)<\/a:Estado>/);
    return m ? m[1] : 'No verificado';
  } catch (e) { return 'No verificado'; }
}

/* ===================== Para pruebas en node ===================== */
if (typeof module !== 'undefined') {
  module.exports = { pagadorDeSede: pagadorDeSede, PAGADORES_SEMILLA: PAGADORES_SEMILLA, norm: norm, parsearEvento: parsearEvento, planearSincronizacion: planearSincronizacion, calcular: calcular, leerCFDI: leerCFDI, buscarEnTextoLibre: buscarEnTextoLibre, TABULADOR_SEMILLA: TABULADOR_SEMILLA, EQUIVALENCIAS_SEMILLA: EQUIVALENCIAS_SEMILLA };
}
