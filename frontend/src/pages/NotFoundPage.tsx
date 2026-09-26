import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/ui';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found" action={<Link to="/" className="btn-primary">Back to projects</Link>}>
      The address does not match any page in Splat360 Studio.
    </EmptyState>
  );
}
