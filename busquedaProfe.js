import { writeFile } from "fs/promises";

const BASE =
  "https://www.aragon.unam.mx/horarios/horarios/index_archivos/php/queysA.php";

const NOMBRE_BUSCAR = "Ramirez Lazos Esteban";

const SEM = process.env.SEM || "35";
const SALIDA = process.env.BUSQUEDA_OUT || "busqueda_profe.json";
const CONCURRENCIA = parseInt(process.env.CONCURRENCIA || "8", 10);
const INTENTOS = 3;

const ENTIDADES = {
  "&Aacute;": "Á",
  "&Eacute;": "É",
  "&Iacute;": "Í",
  "&Oacute;": "Ó",
  "&Uacute;": "Ú",
  "&Ntilde;": "Ñ",
  "&aacute;": "á",
  "&eacute;": "é",
  "&iacute;": "í",
  "&oacute;": "ó",
  "&uacute;": "ú",
  "&ntilde;": "ñ",
  "&uuml;": "ü",
  "&Uuml;": "Ü",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

const decodificar = (texto) =>
  texto.replace(/&[A-Za-z]+;/g, (entidad) => ENTIDADES[entidad] ?? entidad);

const sinAcentos = (texto) =>
  texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizar = (texto) =>
  sinAcentos(decodificar(texto))
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

const getJSON = async (params) => {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}?${qs}`;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const respuesta = await fetch(url);
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      return await respuesta.json();
    } catch (error) {
      if (intento === INTENTOS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * intento));
    }
  }
};

const procesarConLimite = async (items, limite, fn) => {
  const salidas = new Array(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const indice = siguiente++;
      salidas[indice] = await fn(items[indice], indice);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limite, items.length) }, trabajador),
  );
  return salidas;
};

const formatearHorario = (texto) => {
  if (!texto) return "";
  const limpio = texto.trim().replace(/\s+/g, "");
  const partes = limpio.match(/\d{2}:\d{2}/g);
  if (!partes || partes.length < 2) return limpio;
  return partes.join("-");
};

const TIPOS = { P: "PRESENCIAL", S: "SEMIPRESENCIAL", A: "A DISTANCIA", X: "" };

const mapearClase = (cruda) => ({
  profesor: (cruda.nomb_prof || "").trim(),
  clave: (cruda.clv_materia || "").trim(),
  materia: (cruda.nomb_cmateria || "").trim(),
  grupo: (cruda.grupo || "").trim(),
  tipo: TIPOS[cruda.tipoclase] ?? "",
  horario: {
    LU: formatearHorario(cruda.LU),
    MA: formatearHorario(cruda.MA),
    MI: formatearHorario(cruda.MI),
    JU: formatearHorario(cruda.JU),
    VI: formatearHorario(cruda.VI),
    SA: formatearHorario(cruda.SA),
  },
  salon: (cruda.clv_salon || "") === "SINDEF" ? "-" : (cruda.clv_salon || "").trim(),
  cupo: (cruda.cupo || "").trim(),
});

const tokensBusqueda = normalizar(NOMBRE_BUSCAR).split(" ");

const coincideProfesor = (profesor) => {
  const nombre = normalizar(profesor);
  if (!nombre) return false;
  return tokensBusqueda.every((token) => nombre.includes(token));
};

const gruposDeCarrera = async (idCarrera) => {
  const grupos = (await getJSON({ tipo: 4, sem: SEM, carr: idCarrera })).map(
    (g) => g.grupo,
  );
  return grupos;
};

const scrapearGrupos = async (idCarrera, grupos) => {
  const listas = await procesarConLimite(grupos, CONCURRENCIA, async (grupo) => {
    const crudas = await getJSON({ tipo: 2, sem: SEM, carr: idCarrera, grupo });
    const clases = crudas.map(mapearClase).filter((c) => coincideProfesor(c.profesor));
    return { grupo, clases };
  });
  const resultado = {};
  for (const { grupo, clases } of listas) {
    if (clases.length) resultado[grupo] = clases;
  }
  return resultado;
};

const main = async () => {
  console.log(`🔎 Buscando "${NOMBRE_BUSCAR}" en todas las carreras (sem ${SEM})...`);
  const carreras = (await getJSON({ tipo: 1 })).map((c) => ({
    id: c.id_area,
    nombre: decodificar(c.nombre).trim(),
  }));
  console.log(`🌐 ${carreras.length} carreras encontradas`);

  const resultados = {};
  let totalMaterias = 0;

  for (const carrera of carreras) {
    const grupos = await gruposDeCarrera(carrera.id);
    if (!grupos.length) {
      console.log(`  ⏭  ${carrera.nombre}: sin grupos`);
      continue;
    }
    const coincidentes = await scrapearGrupos(carrera.id, grupos);
    if (Object.keys(coincidentes).length) {
      const materias = Object.values(coincidentes).flat();
      totalMaterias += materias.length;
      resultados[carrera.nombre] = coincidentes;
      console.log(
        `  ✅ ${carrera.nombre}: ${Object.keys(coincidentes).length} grupos, ${materias.length} materias`,
      );
    } else {
      console.log(`  ⏭  ${carrera.nombre}: sin coincidencias`);
    }
  }

  if (Object.keys(resultados).length) {
    await writeFile(SALIDA, JSON.stringify(resultados, null, 2), "utf-8");
    console.log(`✅ Escrito ${SALIDA}`);
    console.log(`🏁 ${totalMaterias} materias en total`);
  } else {
    console.log(`❌ Sin resultados para "${NOMBRE_BUSCAR}"`);
  }
};

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});