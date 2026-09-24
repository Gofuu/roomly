import { useSession } from '../lib/auth';
import { PageHeader } from '../components/ui';

export function HomePage() {
  const { user, org } = useSession();
  return <PageHeader title={`Welcome, ${user.name}`} description={`Signed in to ${org.name}.`} />;
}
