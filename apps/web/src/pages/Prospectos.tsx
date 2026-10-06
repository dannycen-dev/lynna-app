import { ArrowLeft, MessageCircle, Users } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { Empty, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useMessages, useProspects } from "../lib/api";
import { dateTime, num, STAGE_LABEL } from "../lib/format";

function formatPhone(wa: string): string {
  // 5219991234567 → +52 1 999 123 4567 (formato legible MX)
  const m = /^52(1?)(\d{3})(\d{3})(\d{4})$/.exec(wa);
  return m ? `+52 ${m[1] ? "1 " : ""}${m[2]} ${m[3]} ${m[4]}` : `+${wa}`;
}

export function Prospectos() {
  const prospects = useProspects();
  const navigate = useNavigate();

  return (
    <div className="page">
      <PageHeader title="Prospectos" subtitle="Contactos que llegaron por WhatsApp. El pipeline con etapas, asignación a vendedores y citas llega en la siguiente fase." />
      {prospects.isPending && <Spinner />}
      <ErrorAlert error={prospects.error} />
      {prospects.data?.length === 0 && (
        <Empty icon={<Users size={40} />} title="Aún no hay prospectos">
          Aparecerán aquí en cuanto alguien escriba al número de WhatsApp conectado.
        </Empty>
      )}
      {prospects.data && prospects.data.length > 0 && (
        <div className="card table-wrap">
          <table className="table table--hover">
            <thead>
              <tr>
                <th>Contacto</th>
                <th>Teléfono</th>
                <th>Etapa</th>
                <th className="right">Mensajes</th>
                <th>Último mensaje</th>
              </tr>
            </thead>
            <tbody>
              {prospects.data.map((p) => (
                <tr key={p.id} onClick={() => p.conversationId && navigate(`/prospectos/${p.conversationId}`)}>
                  <td>
                    <strong>{p.name ?? p.profileName ?? "Sin nombre"}</strong>
                  </td>
                  <td className="num">{formatPhone(p.phone)}</td>
                  <td>
                    <span className="badge badge--info">{STAGE_LABEL[p.stage] ?? p.stage}</span>
                  </td>
                  <td className="right num">{num(p.messageCount)}</td>
                  <td className="num muted">{p.lastInboundAt ? dateTime(p.lastInboundAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Conversacion() {
  const { conversationId } = useParams();
  const prospects = useProspects();
  const messages = useMessages(conversationId);
  const prospect = prospects.data?.find((p) => p.conversationId === conversationId);

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <Link to="/prospectos" className="backlink">
        <ArrowLeft size={16} /> Prospectos
      </Link>
      <PageHeader
        title={prospect ? (prospect.name ?? prospect.profileName ?? "Sin nombre") : "Conversación"}
        subtitle={prospect ? formatPhone(prospect.phone) : undefined}
      />
      {messages.isPending && <Spinner />}
      <ErrorAlert error={messages.error} />
      {messages.data && (
        <div className="chat">
          {messages.data.length === 0 && <Empty icon={<MessageCircle size={40} />} title="Sin mensajes" />}
          {messages.data.map((m) => (
            <div key={m.id} className={`bubble bubble--${m.direction}`}>
              {m.body ?? <em className="muted">[{m.type}]</em>}
              <span className="bubble__meta">
                {m.direction === "out" && `${m.author === "ai" ? "IA" : m.author === "user" ? "Asesor" : "Sistema"} · `}
                {dateTime(m.waTimestamp ?? m.createdAt)}
                {m.direction === "out" && ` · ${m.status}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
