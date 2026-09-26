import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { NewProjectPage } from '@/pages/NewProjectPage';
import { ProjectPage } from '@/pages/ProjectPage';
import { TagPrinterPage } from '@/pages/TagPrinterPage';
import { CaptureGuidePage } from '@/pages/CaptureGuidePage';
import { DoctorPage } from '@/pages/DoctorPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<Navigate to="/" replace />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/projects/:id/:tab" element={<ProjectPage />} />
        <Route path="/tags" element={<TagPrinterPage />} />
        <Route path="/guide" element={<CaptureGuidePage />} />
        <Route path="/doctor" element={<DoctorPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
