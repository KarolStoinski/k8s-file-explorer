const translations = {
  en: {
    metaDescription:
      "K8s File Explorer is a desktop file explorer for Kubernetes pods, powered by your local kubectl.",
    skip: "Skip to content",
    navFeatures: "Features",
    navWorkflow: "Workflow",
    navRequirements: "Requirements",
    eyebrow: "Desktop explorer for Kubernetes pods",
    heroLead:
      "Browse pod files, move artifacts, and open remote files locally without turning every file task into a chain of kubectl commands.",
    heroPrimary: "Explore features",
    heroSecondary: "Check requirements",
    previewKubectl: "kubectl ready",
    previewContext: "prod-eu / payments",
    previewActivity: "2 active operations",
    previewRemote: "Kubernetes pod",
    previewLocal: "Local files",
    previewName: "Name",
    previewSize: "Size",
    previewModified: "Modified",
    previewTransfers: "Transfers",
    previewDirection: "Direction",
    previewStatus: "Status",
    previewDownload: "pod to local",
    previewRunning: "running",
    signalOneTitle: "Local kubectl",
    signalOneText: "Respects your existing auth, contexts, and plugins.",
    signalTwoTitle: "Two-pane workflow",
    signalTwoText: "Remote pod files and local files stay side by side.",
    signalThreeTitle: "Background transfers",
    signalThreeText: "Downloads and uploads stay visible and cancellable.",
    featuresEyebrow: "Built for daily Kubernetes file work",
    featuresTitle: "A focused file explorer for pods",
    featuresLead:
      "K8s File Explorer keeps the narrow job fast: find a pod, inspect its filesystem, and move files safely through kubectl.",
    featureOneTitle: "Browse pod files visually",
    featureOneText:
      "Move from kubeconfig to namespace, pod, container, and path without rebuilding commands by hand.",
    featureTwoTitle: "Use the kubectl you already trust",
    featureTwoText:
      "The app delegates Kubernetes operations to local kubectl, so it fits existing cluster access rules.",
    featureThreeTitle: "Transfer files in the background",
    featureThreeText:
      "Upload and download work continues in a transfer panel with clear status and cancellation.",
    featureFourTitle: "Open remote files locally",
    featureFourText:
      "Double-click a pod file to download it to a temporary location and open it with your desktop tools.",
    workflowEyebrow: "Workflow",
    workflowTitle: "From cluster to file in a few clicks",
    workflowOneTitle: "Pick a kubeconfig",
    workflowOneText: "Start from the kubeconfigs already present on the machine.",
    workflowTwoTitle: "Choose namespace and pod",
    workflowTwoText: "Load only the Kubernetes fields needed for navigation.",
    workflowThreeTitle: "Browse the container filesystem",
    workflowThreeText: "Inspect folders and file metadata through kubectl exec.",
    workflowFourTitle: "Move or open files",
    workflowFourText: "Use kubectl cp for transfers and keep progress visible.",
    requirementsEyebrow: "Requirements",
    requirementsTitle: "Designed to fit an existing Kubernetes workstation",
    requirementsLead:
      "The desktop app expects the tools and permissions you already use for cluster operations.",
    requirementOne: "Available in PATH and configured for your clusters.",
    requirementTwo: "Stored locally, typically under ~/.kube.",
    requirementThreeTitle: "RBAC access",
    requirementThree: "Permissions for namespaces, pods, exec, and file transfers.",
    footerText: "A lightweight Tauri desktop app built around local kubectl."
  },
  pl: {
    metaDescription:
      "K8s File Explorer to desktopowy eksplorator plików w podach Kubernetes, działający przez lokalny kubectl.",
    skip: "Przejdź do treści",
    navFeatures: "Funkcje",
    navWorkflow: "Przepływ pracy",
    navRequirements: "Wymagania",
    eyebrow: "Desktopowy eksplorator podów Kubernetes",
    heroLead:
      "Przeglądaj pliki w podach, przenoś artefakty i otwieraj zdalne pliki lokalnie bez składania za każdym razem sekwencji komend kubectl.",
    heroPrimary: "Zobacz funkcje",
    heroSecondary: "Sprawdź wymagania",
    previewKubectl: "kubectl gotowy",
    previewContext: "prod-eu / payments",
    previewActivity: "2 aktywne operacje",
    previewRemote: "Pod Kubernetes",
    previewLocal: "Pliki lokalne",
    previewName: "Nazwa",
    previewSize: "Rozmiar",
    previewModified: "Zmodyfikowano",
    previewTransfers: "Transfery",
    previewDirection: "Kierunek",
    previewStatus: "Status",
    previewDownload: "z poda lokalnie",
    previewRunning: "w toku",
    signalOneTitle: "Lokalny kubectl",
    signalOneText: "Respektuje istniejącą autoryzację, konteksty i pluginy.",
    signalTwoTitle: "Praca w dwóch panelach",
    signalTwoText: "Pliki poda i pliki lokalne są obok siebie.",
    signalThreeTitle: "Transfery w tle",
    signalThreeText: "Pobrania i wysyłki są widoczne i możliwe do anulowania.",
    featuresEyebrow: "Do codziennej pracy z plikami Kubernetes",
    featuresTitle: "Skupiony eksplorator plików dla podów",
    featuresLead:
      "K8s File Explorer przyspiesza konkretną pracę: znalezienie poda, sprawdzenie jego systemu plików i bezpieczne przenoszenie plików przez kubectl.",
    featureOneTitle: "Przeglądaj pliki poda wizualnie",
    featureOneText:
      "Przechodź od kubeconfigu przez namespace, pod, kontener i ścieżkę bez ręcznego odtwarzania komend.",
    featureTwoTitle: "Używaj kubectl, któremu już ufasz",
    featureTwoText:
      "Aplikacja przekazuje operacje Kubernetes do lokalnego kubectl, więc pasuje do obecnych zasad dostępu do klastrów.",
    featureThreeTitle: "Przenoś pliki w tle",
    featureThreeText:
      "Wysyłanie i pobieranie działa w panelu transferów z czytelnym statusem i anulowaniem.",
    featureFourTitle: "Otwieraj zdalne pliki lokalnie",
    featureFourText:
      "Dwuklik na pliku w podzie pobiera go do katalogu tymczasowego i otwiera w narzędziach desktopowych.",
    workflowEyebrow: "Przepływ pracy",
    workflowTitle: "Od klastra do pliku w kilku kliknięciach",
    workflowOneTitle: "Wybierz kubeconfig",
    workflowOneText: "Zacznij od kubeconfigów, które są już na komputerze.",
    workflowTwoTitle: "Wybierz namespace i pod",
    workflowTwoText: "Ładuj tylko te pola Kubernetes, które są potrzebne do nawigacji.",
    workflowThreeTitle: "Przeglądaj system plików kontenera",
    workflowThreeText: "Sprawdzaj foldery i metadane plików przez kubectl exec.",
    workflowFourTitle: "Przenieś albo otwórz pliki",
    workflowFourText: "Używaj kubectl cp do transferów i obserwuj ich postęp.",
    requirementsEyebrow: "Wymagania",
    requirementsTitle: "Dopasowany do istniejącego stanowiska Kubernetes",
    requirementsLead:
      "Aplikacja desktopowa oczekuje tych samych narzędzi i uprawnień, których już używasz do pracy z klastrami.",
    requirementOne: "Dostępny w PATH i skonfigurowany dla Twoich klastrów.",
    requirementTwo: "Zapisany lokalnie, zwykle w ~/.kube.",
    requirementThreeTitle: "Dostęp RBAC",
    requirementThree: "Uprawnienia do namespaces, pods, exec oraz transferu plików.",
    footerText: "Lekka aplikacja desktopowa Tauri zbudowana wokół lokalnego kubectl."
  }
};

const languageButtons = document.querySelectorAll("[data-language]");
const translatedElements = document.querySelectorAll("[data-i18n]");

function detectLanguage() {
  const savedLanguage = localStorage.getItem("k8s-file-explorer-language");
  if (savedLanguage === "pl" || savedLanguage === "en") {
    return savedLanguage;
  }

  const preferredLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return preferredLanguages.some((language) => language.toLowerCase().startsWith("pl")) ? "pl" : "en";
}

function setLanguage(language) {
  const dictionary = translations[language] ?? translations.en;
  document.documentElement.lang = language;
  document.title = "K8s File Explorer";

  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) {
    metaDescription.setAttribute("content", dictionary.metaDescription);
  }

  translatedElements.forEach((element) => {
    const key = element.dataset.i18n;
    if (key && dictionary[key]) {
      element.textContent = dictionary[key];
    }
  });

  languageButtons.forEach((button) => {
    const isActive = button.dataset.language === language;
    button.setAttribute("aria-pressed", String(isActive));
  });
}

languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const language = button.dataset.language;
    if (language === "pl" || language === "en") {
      localStorage.setItem("k8s-file-explorer-language", language);
      setLanguage(language);
    }
  });
});

setLanguage(detectLanguage());
