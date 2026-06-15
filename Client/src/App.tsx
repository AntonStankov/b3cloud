import { Route, Routes } from "react-router-dom";
import LandingPage from "./features/landing/LandingPage";
import BuilderPage from "./features/builder/BuilderPage";
import CheckoutPage from "./features/checkout/CheckoutPage";
import DemoPage from "./features/demo/DemoPage";
import DashboardPage from "./features/dashboard/DashboardPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/builder/:projectId" element={<BuilderPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/subscribe" element={<CheckoutPage />} />
      <Route path="/demo" element={<DemoPage />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}
