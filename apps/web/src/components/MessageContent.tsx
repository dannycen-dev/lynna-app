import { FileText, GalleryHorizontal, MapPin } from "lucide-react";
import type { Message } from "../lib/types";

/**
 * Contenido de un mensaje de WhatsApp tal como lo vio el prospecto: texto, foto, PDF, ubicación o carrusel
 * de lotes. Lo que manda Lynna se sirve desde /media/:id; lo que manda el prospecto (INE, comprobantes)
 * no se muestra aquí por privacidad.
 */
export function MessageContent({ m }: { m: Message }) {
  const own = m.direction === "out" && m.mediaId;
  switch (m.type) {
    case "template":
      return (
        <>
          <em className="muted">Seguimiento automático · </em>
          {m.body}
        </>
      );
    case "image":
      return own ? (
        <figure className="bubble__media">
          <a href={`/media/${m.mediaId}`} target="_blank" rel="noreferrer">
            <img src={`/media/${m.mediaId}`} alt={m.body ?? "Imagen enviada"} loading="lazy" />
          </a>
          {m.body && <figcaption>{m.body}</figcaption>}
        </figure>
      ) : (
        <>
          <em className="muted">[imagen] </em>
          {m.body}
        </>
      );
    case "document":
      return own ? (
        <a className="bubble__doc" href={`/media/${m.mediaId}`} target="_blank" rel="noreferrer">
          <FileText size={18} aria-hidden /> <span>{m.body ?? "Documento PDF"}</span>
        </a>
      ) : (
        <>
          <em className="muted">[archivo] </em>
          {m.body}
        </>
      );
    case "location": {
      const coords = /(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(m.body ?? "");
      const label = (m.body ?? "").replace(/ · -?\d+\.\d+,-?\d+\.\d+$/, "");
      return coords ? (
        <a className="bubble__doc" href={`https://www.google.com/maps?q=${coords[1]},${coords[2]}`} target="_blank" rel="noreferrer">
          <MapPin size={18} aria-hidden /> <span>{label || "Ubicación"}</span>
        </a>
      ) : (
        <>
          <em className="muted">[ubicación] </em>
          {m.body}
        </>
      );
    }
    case "carousel": {
      const [title, ...cards] = (m.body ?? "").split("\n");
      return (
        <div className="bubble__carousel">
          <span className="bubble__doc">
            <GalleryHorizontal size={18} aria-hidden /> <span>{title || "Carrusel"} · {cards.length / 2} lotes</span>
          </span>
          {own && <img src={`/media/${m.mediaId}`} alt="" loading="lazy" />}
          <ul>
            {pairs(cards).map(([lot, detail]) => (
              <li key={lot}>
                <strong>{lot}</strong> {detail}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "text":
      return <>{m.body}</>;
    default:
      return (
        <>
          <em className="muted">[{m.type}] </em>
          {m.body}
        </>
      );
  }
}

/** Cada tarjeta del carrusel se guarda en dos líneas: "Manzana A, lote 1" y "200 m² · $560,000 MXN". */
function pairs(lines: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < lines.length; i += 2) out.push([lines[i]!, lines[i + 1] ?? ""]);
  return out;
}
