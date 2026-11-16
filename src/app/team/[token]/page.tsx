import type { Metadata } from 'next';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { TeamOrderForm } from '@/components/team-order-form';
import { findTeamOrder, isOpen, londonToday, nameOffered } from '@/lib/services/team-orders';
import { submitTeamOrderAction } from './actions';

// Absolute title: customer pages never mention COS.
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const found = await findTeamOrder((await params).token);
  return { title: { absolute: found ? found.team.title : 'Team order' }, robots: { index: false, follow: false } };
}

export default async function TeamOrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await findTeamOrder(token);
  if (!found) return <InvalidLink title="This page isn’t available" body="This order link isn’t valid. Please check it with the shop." />;
  const { team, org } = found;
  const open = isOpen(team, londonToday());
  const closes = team.closesOn ? new Date(`${team.closesOn}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : null;
  return (
    <PublicShell org={org}>
      <div className="team-main">
        <div className="design-intro">
          {team.teamName ? <div className="team-eyebrow">{team.teamName}</div> : null}
          <h1>{team.title}</h1>
          {team.description ? <p className="team-desc">{team.description}</p> : null}
          {open && closes ? <p className="team-closes">Order by {closes}</p> : null}
        </div>
        {open ? (
          <TeamOrderForm
            action={submitTeamOrderAction.bind(null, token)}
            brand={team.brand}
            items={team.items.map((i) => ({ id: i.id, product: i.product, colour: i.colour, pricePence: i.pricePence, sizes: i.sizes, image: i.imageKey ? `/api/team/${token}/image/${i.id}` : null }))}
            namePricePence={team.namePricePence}
            nameOffered={nameOffered(team)}
            namePlacement={team.namePlacement}
            nameMaxLength={team.nameMaxLength}
            terms={team.terms}
          />
        ) : (
          <div className="notice">Orders for this have now closed. If you’d still like something, please contact the shop.</div>
        )}
      </div>
    </PublicShell>
  );
}
