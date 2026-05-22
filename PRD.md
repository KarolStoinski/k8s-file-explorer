# PRD: k8s-file-explorer

## 1. Cel produktu

`k8s-file-explorer` to desktopowa aplikacja w Tauri do eksplorowania plików w podach Kubernetes oraz transferu plików między lokalnym komputerem a kontenerami w klastrach. Interfejs ma działać podobnie do FileZilli: po lewej stronie znajduje się eksplorator zasobów Kubernetes, po prawej eksplorator lokalnego systemu plików.

Produkt ma uprościć typowe operacje developerskie i operatorskie:

- szybkie przechodzenie po wielu konfiguracjach Kubernetes z `~/.kube`,
- wybór klastra, namespace'a, poda i kontenera,
- eksplorowanie systemu plików wewnątrz poda,
- pobieranie i wysyłanie plików,
- lokalne otwieranie plików z poda bez ręcznego używania `kubectl exec` i `kubectl cp`.

## 2. Problem

Praca z plikami w podach Kubernetes zwykle wymaga ręcznego wykonywania komend:

- `kubectl --kubeconfig ... get namespaces`
- `kubectl --kubeconfig ... get pods -n ...`
- `kubectl exec ... -- ls ...`
- `kubectl cp ...`

Jest to niewygodne przy wielu klastrach, częstym przechodzeniu po katalogach, kopiowaniu pojedynczych plików i szybkim podglądzie konfiguracji lub logów. Użytkownik potrzebuje narzędzia, które mapuje klastry i pody na znany model eksploratora plików.

## 3. Użytkownicy

Główne grupy użytkowników:

- developer pracujący z aplikacjami uruchamianymi w Kubernetes,
- DevOps/SRE diagnozujący zawartość kontenerów,
- tester lub support engineer pobierający artefakty, logi i pliki konfiguracyjne z poda.

Zakładamy, że użytkownik:

- ma lokalnie zainstalowany `kubectl`,
- ma działające pliki kubeconfig w `~/.kube`,
- ma uprawnienia do `get/list pods`, `get/list namespaces`, `pods/exec` oraz opcjonalnie transferu przez `kubectl cp`.

## 4. Zakres MVP

MVP obejmuje:

- aplikację desktopową w Tauri,
- dwupanelowy interfejs a'la FileZilla,
- automatyczne wykrywanie kubeconfigów w `~/.kube`,
- prezentowanie każdego kubeconfigu jako katalogu głównego w lewym panelu,
- listowanie namespace'ów jako katalogów pod wybranym kubeconfigiem,
- listowanie podów jako katalogów pod namespace'em,
- wejście do poda i pobranie katalogu `/` przez `kubectl exec -- ls`,
- dalszą eksplorację katalogów w podzie,
- lokalny eksplorator plików w prawym panelu, domyślnie otwarty w katalogu domowym użytkownika,
- transfer plików z lokalnego komputera do poda,
- transfer plików z poda na lokalny komputer,
- dwuklik na pliku w podzie z pytaniem, czy pobrać go do katalogu tymczasowego i otworzyć lokalnie.

## 5. Poza zakresem MVP

W MVP nie planujemy:

- edycji plików bezpośrednio w podzie z automatycznym zapisem zwrotnym,
- terminala interaktywnego w podzie,
- obsługi CRD jako osobnych typów zasobów,
- zarządzania deploymentami, rolloutami lub skalowaniem,
- pełnego klienta Kubernetes API bez `kubectl`,
- synchronizacji katalogów w tle,
- wbudowanego edytora kodu,
- zarządzania sekretami poza zwykłym odczytem plików dostępnych w kontenerze.

## 6. Główne założenia produktowe

- Lewy panel reprezentuje zdalne środowisko Kubernetes.
- Prawy panel reprezentuje lokalny system plików.
- Kubeconfigi są pierwszym poziomem drzewa po stronie Kubernetes.
- Namespace'y są drugim poziomem.
- Pody są trzecim poziomem.
- System plików kontenera jest eksplorowany dopiero po wejściu do poda.
- Aplikacja korzysta z lokalnego `kubectl`, aby respektować istniejące mechanizmy autoryzacji, proxy, pluginy auth i konteksty użytkownika.
- Operacje destrukcyjne, takie jak nadpisanie pliku, wymagają jawnego potwierdzenia.

## 7. Struktura interfejsu

### 7.1 Układ główny

Aplikacja ma jeden główny widok:

- pasek górny ze statusem `kubectl`, aktywnymi operacjami i podstawowymi akcjami odświeżania,
- lewy panel: eksplorator Kubernetes,
- prawy panel: eksplorator lokalny,
- dolny panel: kolejka transferów i log operacji.

Układ powinien pozwalać na zmianę szerokości paneli przez przeciąganie separatora.

### 7.2 Lewy panel: Kubernetes

Po starcie aplikacja skanuje katalog `~/.kube` i pokazuje wykryte konfiguracje jako katalogi główne.

Przykładowe drzewo:

```text
Kubernetes
├── config
│   ├── default
│   │   ├── api-pod-7b6c9f
│   │   │   ├── /
│   │   │   ├── app
│   │   │   └── var
│   │   └── worker-pod-54c1aa
│   └── monitoring
│       └── prometheus-0
├── dev.yaml
└── prod.yaml
```

Wymagania:

- każdy poprawny plik kubeconfig w `~/.kube` jest pokazywany jako katalog,
- pliki niebędące kubeconfigami są ignorowane lub oznaczane jako niepoprawne w widoku diagnostycznym,
- kliknięcie kubeconfigu ładuje namespace'y,
- kliknięcie namespace'a ładuje pody,
- kliknięcie poda ładuje root systemu plików kontenera,
- katalogi i pliki w podzie są rozróżniane wizualnie,
- ścieżka bieżąca jest widoczna jako breadcrumb.

### 7.3 Wybór kontenera w podzie

Jeżeli pod ma jeden kontener, aplikacja używa go automatycznie.

Jeżeli pod ma więcej niż jeden kontener:

- wejście do poda pokazuje listę kontenerów jako kolejny poziom drzewa albo wymusza wybór kontenera w selektorze,
- wybrany kontener jest zapamiętywany dla danego poda w trakcie sesji,
- wszystkie operacje `exec` i transferu są wykonywane na wybranym kontenerze.

### 7.4 Prawy panel: lokalny eksplorator

Prawy panel pokazuje lokalny system plików.

Wymagania:

- domyślna lokalizacja startowa to katalog domowy użytkownika,
- użytkownik może przechodzić po katalogach,
- użytkownik może wrócić do katalogu nadrzędnego,
- pliki i katalogi są sortowane w przewidywalny sposób: katalogi przed plikami, potem alfabetycznie,
- ścieżka bieżąca jest widoczna jako breadcrumb lub pole ścieżki,
- podstawowe metadane pliku są widoczne: nazwa, typ, rozmiar, data modyfikacji.

### 7.5 Kolejka transferów

Dolny panel pokazuje:

- aktywne transfery,
- zakończone transfery,
- błędy,
- kierunek transferu,
- ścieżkę źródłową,
- ścieżkę docelową,
- status i czas wykonania.

## 8. Kluczowe przepływy użytkownika

### 8.1 Start aplikacji

1. Użytkownik uruchamia aplikację.
2. Aplikacja sprawdza dostępność `kubectl`.
3. Aplikacja skanuje `~/.kube`.
4. Lewy panel pokazuje dostępne kubeconfigi.
5. Prawy panel pokazuje katalog domowy użytkownika.
6. Jeżeli `kubectl` nie jest dostępny, aplikacja pokazuje błąd z instrukcją instalacji lub konfiguracji PATH.

### 8.2 Eksplorowanie poda

1. Użytkownik klika kubeconfig w lewym panelu.
2. Aplikacja wywołuje `kubectl --kubeconfig <path> get namespaces`.
3. Użytkownik klika namespace.
4. Aplikacja wywołuje `kubectl --kubeconfig <path> -n <namespace> get pods`.
5. Użytkownik klika pod.
6. Aplikacja ustala kontener, jeśli jest to konieczne.
7. Aplikacja wywołuje `kubectl exec` z komendą listującą katalog `/`.
8. Użytkownik przechodzi po katalogach poda jak po systemie plików.

### 8.3 Pobranie i lokalne otwarcie pliku z poda

1. Użytkownik klika dwa razy plik w lewym panelu.
2. Aplikacja pokazuje modal:
   `Pobrać plik do katalogu tymczasowego i otworzyć lokalnie?`
3. Użytkownik wybiera `Pobierz i otwórz`.
4. Aplikacja pobiera plik do katalogu tymczasowego aplikacji.
5. Aplikacja otwiera plik przez domyślną aplikację systemową.
6. Plik tymczasowy jest rejestrowany do późniejszego sprzątania.

### 8.4 Transfer lokalny -> pod

1. Użytkownik zaznacza plik lub katalog w prawym panelu.
2. Użytkownik wybiera docelowy katalog w lewym panelu.
3. Użytkownik klika przycisk wysyłania albo przeciąga element do lewego panelu.
4. Aplikacja pokazuje potwierdzenie, jeśli plik docelowy istnieje.
5. Aplikacja wykonuje transfer.
6. Po sukcesie aplikacja odświeża docelowy katalog w podzie.

### 8.5 Transfer pod -> lokalnie

1. Użytkownik zaznacza plik lub katalog w lewym panelu.
2. Użytkownik wybiera docelowy katalog w prawym panelu.
3. Użytkownik klika przycisk pobierania albo przeciąga element do prawego panelu.
4. Aplikacja pokazuje potwierdzenie, jeśli plik lokalny istnieje.
5. Aplikacja wykonuje transfer.
6. Po sukcesie aplikacja odświeża docelowy katalog lokalny.

## 9. Wymagania funkcjonalne

### 9.1 Wykrywanie kubeconfigów

- Aplikacja skanuje `~/.kube`.
- Domyślny plik `~/.kube/config` jest obsługiwany.
- Dodatkowe pliki YAML/YML w `~/.kube` są traktowane jako kandydaci na kubeconfig.
- Aplikacja waliduje kubeconfig przez próbę odczytu kontekstów lub namespace'ów.
- Użytkownik może ręcznie odświeżyć listę kubeconfigów.

### 9.2 Listowanie namespace'ów

- Namespace'y są pobierane przez `kubectl`.
- Wynik jest parsowany jako JSON, nie przez tekst tabelaryczny.
- Błędy autoryzacji, timeouty i brak połączenia są pokazywane w UI przy danym kubeconfigu.

Preferowana komenda:

```text
kubectl --kubeconfig <path> get namespaces -o json
```

### 9.3 Listowanie podów

- Pody są pobierane dla wybranego namespace'a.
- UI pokazuje nazwę poda oraz podstawowy status.
- Pody w stanie niedostępnym są widoczne, ale operacje plikowe mogą być zablokowane.

Preferowana komenda:

```text
kubectl --kubeconfig <path> -n <namespace> get pods -o json
```

### 9.4 Eksploracja systemu plików poda

- Po wejściu do poda aplikacja listuje `/`.
- Wejście do katalogu wykonuje kolejne listowanie dla wskazanej ścieżki.
- Aplikacja musi obsługiwać ścieżki ze spacjami i znakami specjalnymi.
- Aplikacja powinna rozpoznawać minimum: plik, katalog, symlink, brak uprawnień.

Preferowana komenda dla MVP:

```text
kubectl --kubeconfig <path> -n <namespace> exec <pod> -c <container> -- ls -la <remote-path>
```

Docelowo lepszym formatem jest stabilny output oparty o `find` lub skrypt shellowy emitujący JSON-lines, jeżeli obraz kontenera ma dostępne wymagane narzędzia.

### 9.5 Transfer plików

Transfer powinien używać `kubectl cp`, jeżeli jest dostępny i działa dla danego kontenera.

Przykład pobierania:

```text
kubectl --kubeconfig <path> -n <namespace> cp <pod>:<remote-path> <local-path> -c <container>
```

Przykład wysyłania:

```text
kubectl --kubeconfig <path> -n <namespace> cp <local-path> <pod>:<remote-path> -c <container>
```

Wymagania:

- aplikacja pokazuje postęp operacji, nawet jeśli w MVP jest to status indeterminate,
- aplikacja obsługuje błędy braku `tar` w kontenerze,
- aplikacja pokazuje czytelny komunikat, gdy `kubectl cp` nie może działać,
- aplikacja pyta o nadpisanie istniejącego pliku.

### 9.6 Dwuklik na pliku z poda

- Dwuklik na katalogu w podzie otwiera katalog.
- Dwuklik na pliku w podzie pokazuje pytanie o pobranie do katalogu tymczasowego.
- Po potwierdzeniu plik trafia do katalogu tymczasowego aplikacji.
- Plik jest otwierany przez systemową aplikację domyślną.
- Jeżeli pobranie się nie uda, aplikacja pokazuje błąd i nie próbuje otwierać pliku.

### 9.7 Odświeżanie

- Użytkownik może odświeżyć aktualny poziom drzewa.
- Po transferze katalog docelowy jest odświeżany automatycznie.
- Cache listingów nie może ukrywać świeżo wykonanych zmian.

## 10. Wymagania niefunkcjonalne

### 10.1 Bezpieczeństwo

- Aplikacja nie zapisuje sekretów kubeconfig poza istniejącymi plikami użytkownika.
- Ścieżki i argumenty do `kubectl` są przekazywane jako osobne argumenty procesu, nie jako sklejony string shellowy.
- Aplikacja nie wykonuje arbitralnych komend wpisanych przez użytkownika w MVP.
- Operacje na plikach tymczasowych są ograniczone do katalogu tymczasowego aplikacji.
- Nadpisywanie plików wymaga potwierdzenia.
- Błędy nie powinny logować tokenów, certyfikatów ani pełnych wartości sekretów.

### 10.2 Wydajność

- Start aplikacji powinien zająć poniżej 3 sekund bez aktywnych zapytań do klastrów.
- Namespace'y i pody są ładowane leniwie po kliknięciu.
- UI nie może blokować się podczas wykonywania `kubectl`.
- Długie operacje mają widoczny status i możliwość anulowania w wersji docelowej.

### 10.3 Stabilność

- Każde wywołanie `kubectl` ma timeout.
- Błędy jednego kubeconfigu nie blokują pracy z innymi kubeconfigami.
- Aplikacja obsługuje brak połączenia z klastrem.
- Aplikacja obsługuje pod usunięty w trakcie eksploracji.

### 10.4 Wieloplatformowość

MVP powinno działać na:

- Windows,
- macOS,
- Linux.

Szczególną uwagę należy zwrócić na:

- ścieżki Windows,
- katalog domowy użytkownika,
- otwieranie plików domyślną aplikacją systemową,
- separator ścieżek lokalnych i zdalnych.

## 11. Proponowana architektura Tauri

### 11.1 Frontend

Frontend odpowiada za:

- widok dwóch paneli,
- drzewo Kubernetes,
- lokalny eksplorator plików,
- modal potwierdzający operacje,
- kolejkę transferów,
- stan zaznaczenia i aktywne ścieżki.

Rekomendowany stan aplikacji:

- lista kubeconfigów,
- aktywny kubeconfig,
- aktywny namespace,
- aktywny pod,
- aktywny kontener,
- aktywna ścieżka zdalna,
- aktywna ścieżka lokalna,
- cache listingów,
- kolejka operacji.

### 11.2 Backend Tauri/Rust

Backend odpowiada za:

- skanowanie `~/.kube`,
- walidację kubeconfigów,
- uruchamianie `kubectl` jako procesów potomnych,
- parsowanie JSON z `kubectl`,
- listowanie lokalnych katalogów,
- transfery plików,
- tworzenie i sprzątanie katalogu tymczasowego aplikacji,
- otwieranie plików lokalną aplikacją systemową.

Przykładowe komendy Tauri:

- `scan_kubeconfigs() -> Vec<KubeconfigEntry>`
- `list_namespaces(kubeconfig_path) -> Vec<NamespaceEntry>`
- `list_pods(kubeconfig_path, namespace) -> Vec<PodEntry>`
- `list_containers(kubeconfig_path, namespace, pod) -> Vec<ContainerEntry>`
- `list_remote_dir(target, remote_path) -> Vec<RemoteFileEntry>`
- `list_local_dir(local_path) -> Vec<LocalFileEntry>`
- `copy_remote_to_local(source, destination) -> TransferResult`
- `copy_local_to_remote(source, destination) -> TransferResult`
- `download_remote_to_temp(source) -> TempDownloadResult`
- `open_local_file(local_path) -> OpenResult`

## 12. Model danych

### 12.1 Kubeconfig

```text
KubeconfigEntry
- id
- name
- path
- is_valid
- error
```

### 12.2 Namespace

```text
NamespaceEntry
- name
- status
```

### 12.3 Pod

```text
PodEntry
- name
- namespace
- phase
- ready
- restart_count
- containers
```

### 12.4 Plik zdalny

```text
RemoteFileEntry
- name
- path
- kind: file | directory | symlink | unknown
- size
- permissions
- owner
- group
- modified_at
- can_read
- error
```

### 12.5 Plik lokalny

```text
LocalFileEntry
- name
- path
- kind: file | directory | symlink | unknown
- size
- modified_at
- readonly
```

### 12.6 Transfer

```text
TransferEntry
- id
- direction: local_to_remote | remote_to_local
- source
- destination
- status: queued | running | success | failed | cancelled
- started_at
- finished_at
- error
```

## 13. Obsługa błędów

Aplikacja powinna pokazywać błędy blisko miejsca, którego dotyczą:

- błąd kubeconfigu przy katalogu kubeconfigu,
- błąd namespace'ów przy liście namespace'ów,
- błąd poda przy konkretnym podzie,
- błąd transferu w kolejce transferów.

Przykładowe komunikaty:

- `Nie znaleziono kubectl w PATH.`
- `Brak dostępu do listy namespace'ów dla tego kubeconfigu.`
- `Pod nie jest już dostępny. Odśwież namespace.`
- `Kontener nie ma narzędzia tar, więc kubectl cp nie może wykonać transferu.`
- `Nie można odczytać katalogu: brak uprawnień.`

## 14. Uprawnienia i zależności

Wymagane lokalnie:

- `kubectl`,
- dostęp do `~/.kube`,
- uprawnienia systemowe do odczytu i zapisu lokalnych plików wybranych przez użytkownika.

Wymagane w klastrze:

- `get/list namespaces`,
- `get/list pods`,
- `create pods/exec` lub równoważne uprawnienie do `kubectl exec`,
- uprawnienia wynikające z użytkownika w kontenerze do odczytu/zapisu plików,
- `tar` w kontenerze dla `kubectl cp`, jeśli ta ścieżka transferu jest używana.

## 15. Kryteria akceptacji MVP

- Po uruchomieniu aplikacja pokazuje kubeconfigi z `~/.kube` w lewym panelu.
- Kliknięcie kubeconfigu pokazuje namespace'y.
- Kliknięcie namespace'a pokazuje pody.
- Kliknięcie poda pokazuje katalog `/` kontenera.
- Użytkownik może wejść w katalogi wewnątrz poda.
- Prawy panel startuje w katalogu domowym użytkownika.
- Użytkownik może przechodzić po lokalnych katalogach.
- Użytkownik może pobrać plik z poda do lokalnego katalogu.
- Użytkownik może wysłać plik lokalny do katalogu w podzie.
- Dwuklik na pliku w podzie pyta o pobranie do katalogu tymczasowego i otwarcie lokalnie.
- Błędy `kubectl` są widoczne w UI i nie zawieszają aplikacji.
- Operacje `kubectl` nie blokują renderowania UI.

## 16. Metryki sukcesu

- Użytkownik może przejść od startu aplikacji do listy plików w podzie bez wpisywania komend.
- Pobranie pojedynczego pliku z poda wymaga maksymalnie kilku kliknięć.
- Transfer pliku w obie strony działa dla standardowych obrazów kontenerów z `tar`.
- Błąd braku uprawnień lub braku `kubectl` jest zrozumiały bez sprawdzania logów developerskich.

## 17. Roadmapa po MVP

Potencjalne rozszerzenia:

- drag and drop między panelami,
- anulowanie transferów,
- zapamiętywanie ostatnich ścieżek dla kubeconfigów i lokalnego panelu,
- szybka wyszukiwarka plików w aktualnym katalogu,
- obsługa podglądu tekstowego bez otwierania zewnętrznej aplikacji,
- zapis zmian z pliku tymczasowego z powrotem do poda,
- obsługa wielu aktywnych kart,
- filtrowanie podów po labelach,
- ręczne dodawanie kubeconfigu spoza `~/.kube`,
- integracja z Kubernetes API jako alternatywa dla `kubectl` dla listowania zasobów,
- fallback transferu przez `exec` i strumieniowanie, gdy `kubectl cp` nie działa.

## 18. Otwarte pytania

- Czy kubeconfig z wieloma kontekstami ma być pokazany jako jeden katalog, czy konteksty mają być osobnym poziomem drzewa?
- Czy aplikacja ma obsługiwać tylko pierwszy kontener w podzie, czy od MVP wymagać pełnego wyboru kontenera?
- Czy transfer katalogów ma być w MVP, czy tylko transfer pojedynczych plików?
- Czy dwuklik na pliku lokalnym ma również otwierać go lokalnie?
- Czy aplikacja ma pozwalać na ukrywanie systemowych i ukrytych plików lokalnych?
- Jak długo przechowywać pobrane pliki tymczasowe?
- Czy aplikacja ma mieć tryb read-only, blokujący wysyłanie plików do poda?
