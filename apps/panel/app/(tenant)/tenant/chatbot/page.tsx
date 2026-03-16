import { ChatbotStudio } from "../../../../components/tenant/chatbot-studio";
import { getTenantInstances } from "../../../../lib/api";

export default async function TenantChatbotPage() {
  const instances = await getTenantInstances();
  return <ChatbotStudio initialInstances={instances} />;
}
