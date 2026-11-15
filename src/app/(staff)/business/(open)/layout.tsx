import { BusinessBar } from '@/components/business-ui';
import { BUSINESS_IDLE_MINUTES, requireBusiness } from '@/lib/business-lock';
import { lockAction, renewAction } from '../actions';

/** Everything under /business (except the unlock screen) needs the owner, unlocked. */
export default async function BusinessLayout({ children }: { children: React.ReactNode }) {
  await requireBusiness();
  return (
    <div className="biz">
      <BusinessBar renew={renewAction} lock={lockAction} idleMinutes={BUSINESS_IDLE_MINUTES} />
      {children}
    </div>
  );
}
