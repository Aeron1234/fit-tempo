import { CircleAlert, FileQuestion } from 'lucide-react';
import { StatusPage } from '@/components/shared/StatusPage';
import { Button } from '@/components/ui/button';
import { Link, useNavigate } from 'react-router-dom';

export function RouteErrorPage({ notFound = false }: { notFound?: boolean }) {
  const navigate = useNavigate();
  return (
    <StatusPage title={notFound ? "Page not found" : "This page couldn’t load"}
      description={notFound ? "Check the address or return to Fit Tempo." : "Reload the page to try again."}
      icon={notFound ? FileQuestion : CircleAlert}>
      {!notFound && <Button onClick={() => void navigate(0)}>Reload page</Button>}
      <Button asChild variant={notFound ? "default" : "ghost"}><Link to="/">Return to Fit Tempo</Link></Button>
    </StatusPage>
  )
}
