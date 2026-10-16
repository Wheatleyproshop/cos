import type { ReactNode } from 'react';
import { fitSpec, priceText, type SpecBuild } from '@/lib/fit-spec';
import { money } from '@/lib/format';

/** One club: a heading with its price, then each detail (Head, Loft, Shaft, Flex, Grip…) on its own line. */
export function BuildTable({ build, index, actions }: { build: SpecBuild; index?: number; actions?: ReactNode }) {
  return (
    <div className="specbuild">
      <div className="specbuild-head">
        <b>
          {index !== undefined ? <span className="specnum">{index + 1}</span> : null}
          {build.title}
        </b>
        <span className="specbuild-total">{money(build.totalPence)}</span>
      </div>
      <table className="spectable">
        <tbody>
          {build.lines.map((l, i) => (
            <tr key={i}>
              <th scope="row">{l.label}</th>
              <td>
                {l.value}
                {l.detail ? <small>{l.detail}</small> : null}
              </td>
              <td className="num">{priceText(l.pricePence)}</td>
            </tr>
          ))}
          {build.notes ? (
            <tr>
              <th scope="row">Notes</th>
              <td colSpan={2} style={{ whiteSpace: 'pre-line' }}>
                {build.notes}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {actions ? <div className="specbuild-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * A quote/order specification. Custom Fitting specs are shown club by club, line by line;
 * anything else (manual quotes, ball printing) is shown as the text, keeping its line breaks.
 */
export function SpecView({ json, text, label = 'Specification' }: { json: unknown; text: string; label?: string }) {
  const spec = fitSpec(json);
  if (!spec) {
    return (
      <div className="detailbox specplain">
        <small>{label}</small>
        <div>{text}</div>
      </div>
    );
  }
  return (
    <div className="specview" aria-label={label}>
      {spec.builds.map((b, i) => (
        <BuildTable key={i} build={b} index={spec.builds.length > 1 ? i : undefined} />
      ))}
      {spec.notes ? (
        <div className="specnotes">
          <small>Fitting notes</small>
          <div>{spec.notes}</div>
        </div>
      ) : null}
      {spec.builds.length > 1 ? (
        <div className="spectotal">
          <span>Total for {spec.builds.length} clubs</span>
          <b>{money(spec.totalPence)}</b>
        </div>
      ) : null}
    </div>
  );
}
