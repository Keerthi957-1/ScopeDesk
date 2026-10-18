document.addEventListener('DOMContentLoaded', () => {
    
    // ================= CLIENT-SIDE SIMULATED LOGICAL MEMORY SYSTEM =================
    const ENGINE_STATE = {
        activeUser: null,    // Populated as: { username: '...', role: 'client' | 'vendor' }
        selectedSession: null, // Holds the active ticket item reference current attached inside remote viewport
        tickets: [
            { id: 'SCD-1042-XP8B', title: 'Fix Billing Software Invoice PDF Export Engine Error', client: 'Maple & Co.', vendor: 'Northstar IT (Mayo Patel)', status: 'Pending' },
            { id: 'SCD-3091-ZN72', title: 'Configure Split-Tunnel OpenVPN Gateway Routings', client: 'Cedar Dental', vendor: 'SecureNet (Theo Grant)', status: 'Active' }
        ]
    };

    // ================= REGISTRATION OF APPLICATION DOM ELEMENT NODES =================
    // Security Gateway Framework Nodes
    const authContainer = document.getElementById('authContainer');
    const appContainer = document.getElementById('appContainer');
    const authForm = document.getElementById('authForm');
    const authFormTitle = document.getElementById('authFormTitle');
    const authFormSubtitle = document.getElementById('authFormSubtitle');
    const btnSwitchAuthMode = document.getElementById('btnSwitchAuthMode');
    const authToggleText = document.getElementById('authToggleText');
    const roleSelectorGroup = document.getElementById('roleSelectorGroup');
    const authUsername = document.getElementById('authUsername');
    const roleCards = document.querySelectorAll('.role-card');

    // Sidebar & Navigation Nodes
    const navItems = document.querySelectorAll('.nav-menu .nav-item');
    const paneViews = document.querySelectorAll('.pane-view');
    const btnLogOut = document.getElementById('btnLogOut');
    const userNameSlot = document.getElementById('userNameSlot');
    const userRoleBadgeSlot = document.getElementById('userRoleBadgeSlot');
    const userAvatarSlot = document.getElementById('userAvatarSlot');

    // Client Dashboard Panel Nodes
    const clientDashboardPanel = document.getElementById('clientDashboardPanel');
    const clientTasksBody = document.getElementById('clientTasksBody');
    const btnOpenTaskModal = document.getElementById('btnOpenTaskModal');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const taskModal = document.getElementById('taskModal');
    const newTaskForm = document.getElementById('newTaskForm');
    const clientActiveCount = document.getElementById('clientActiveCount');
    const clientTokenCount = document.getElementById('clientTokenCount');

    // Vendor Console Panel Nodes
    const vendorDashboardPanel = document.getElementById('vendorDashboardPanel');
    const vendorTasksBody = document.getElementById('vendorTasksBody');
    const inputTokenKey = document.getElementById('inputTokenKey');
    const btnValidateToken = document.getElementById('btnValidateToken');
    const tokenErrorFeedback = document.getElementById('tokenErrorFeedback');
    const vendorIncomingCount = document.getElementById('vendorIncomingCount');

    // Remote Stream Emulator Subsystem Nodes
    const sessionMonitorPanel = document.getElementById('sessionMonitorPanel');
    const breachAlertBanner = document.getElementById('breachAlertBanner');
    const allowedAppWindow = document.getElementById('allowedAppWindow');
    const btnTriggerBreach = document.getElementById('btnTriggerBreach');
    const btnSimulateBreach = document.getElementById('btnSimulateBreach');
    const btnTerminateSession = document.getElementById('btnTerminateSession');
    const emulatorWindowTitle = document.getElementById('emulatorWindowTitle');
    
    // Telemetry Panel Labels
    const lblScopeTask = document.getElementById('lblScopeTask');
    const lblScopeVendor = document.getElementById('lblScopeVendor');
    const lblScopeToken = document.getElementById('lblScopeToken');

    let registrationActiveState = false;
    let fallbackSelectedRole = 'client';

    // ================= 1. SECURITY SYSTEM GATEWAY ROUTINES =================
    // Alternate between login mode and creation context
    btnSwitchAuthMode.addEventListener('click', () => {
        registrationActiveState = !registrationActiveState;
        if (registrationActiveState) {
            authFormTitle.textContent = "Create your account";
            authFormSubtitle.textContent = "Specify your workspace role category to instantiate appropriate authorization profile tiers.";
            authToggleText.textContent = "Already have an account?";
            btnSwitchAuthMode.textContent = "Sign in →";
            roleSelectorGroup.classList.remove('hidden')
            document.getElementById('emailGroup')?.classList.remove('hidden');
        } else {
            authFormTitle.textContent = "Sign in to ScopeDesk";
            authFormSubtitle.textContent = "Your secure remote support hub, with clear constraints.";
            authToggleText.textContent = "New to ScopeDesk?";
            btnSwitchAuthMode.textContent = "Create an account →";
            roleSelectorGroup.classList.add('hidden');
                        document.getElementById('emailGroup')?.classList.add('hidden');
        }
    });

    // Handle account profile archetype toggle boxes 
    roleCards.forEach(card => {
        card.addEventListener('click', () => {
            roleCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const radioNode = card.querySelector('input[type="radio"]');
            radioNode.checked = true;
            fallbackSelectedRole = radioNode.value;
        });
    });

    // Form confirmation processing loop
       authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
                alert('Button clicked: new code is running');

        const username = authUsername.value.trim();
        const password = document.getElementById('authPassword').value;
    
                const emailBox = document.getElementById('authEmail');
        const email = emailBox ? emailBox.value.trim() : '';

        const url = registrationActiveState ? '/api/register' : '/api/login';
        const body = registrationActiveState
            ? { username, email, password, role: fallbackSelectedRole, organization: null }
            : { username, password };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json();

            if (!response.ok) {
                alert(data.error || 'Something went wrong');
                return;
            }

            if (registrationActiveState) {
                alert('Account created! Please sign in.');
                btnSwitchAuthMode.click();
                return;
            }

            ENGINE_STATE.activeUser = { username: data.username, role: data.role };
            bootApplicationEnvironment();
        } catch (err) {
            alert('Cannot reach the server. Is "node server.js" running?');
        }
    });

    // Clean structural user session termination
    btnLogOut.addEventListener('click', () => {
        ENGINE_STATE.activeUser = null;
        appContainer.classList.add('hidden');
        authContainer.classList.remove('hidden');
        authUsername.value = '';
        document.getElementById('authPassword').value = '';
    });

    // ================= 2. DASHBOARD FRAME RENDERING LOGIC =================
    function bootApplicationEnvironment() {
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');

        // Render header strings context parameters
        userNameSlot.textContent = ENGINE_STATE.activeUser.username;
        userRoleBadgeSlot.textContent = ENGINE_STATE.activeUser.role === 'client' ? 'Office Admin Manager' : 'Authorized Engineer Expert';
        userAvatarSlot.textContent = ENGINE_STATE.activeUser.username.charAt(0).toUpperCase();
        userAvatarSlot.style.backgroundColor = ENGINE_STATE.activeUser.role === 'client' ? '#e28743' : '#2b6cb0';

        if (ENGINE_STATE.activeUser.role === 'client') {
            document.querySelectorAll('.profile-name').forEach(el => el.textContent = ENGINE_STATE.activeUser.username);
            routeToWorkspacePanel('clientDashboardPanel');
            document.getElementById('navOverviewLink').setAttribute('data-target', 'clientDashboardPanel');
        } else {
            routeToWorkspacePanel('vendorDashboardPanel');
            document.getElementById('navOverviewLink').setAttribute('data-target', 'vendorDashboardPanel');
        }

        refreshDataTablesGrid();
    }

    function routeToWorkspacePanel(targetPanelId) {
        paneViews.forEach(pane => pane.classList.add('hidden'));
        const targetNode = document.getElementById(targetPanelId);
        if (targetNode) targetNode.classList.remove('hidden');

        // Refurbish left sidebar link accent highlights
        navItems.forEach(item => item.classList.remove('active'));
        navItems.forEach(item => {
            const pathTarget = item.getAttribute('data-target');
            if (pathTarget === targetPanelId || 
               (item.id === 'navOverviewLink' && (targetPanelId === 'clientDashboardPanel' || targetPanelId === 'vendorDashboardPanel'))) {
                item.classList.add('active');
            }
        });
    }

    // Attach interaction handling logic variables to standard left links menus
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const directTarget = item.getAttribute('data-target');
            
            if (directTarget === 'overview-panel') {
                routeToWorkspacePanel(ENGINE_STATE.activeUser.role === 'client' ? 'clientDashboardPanel' : 'vendorDashboardPanel');
            } else if (directTarget === 'session-panel') {
                if (!ENGINE_STATE.selectedSession) {
                    alert("Operation Blocked: No isolation stream is active. Generate a token under a Client log, copy the key, and fire it up via a Vendor login profile first.");
                    return;
                }
                routeToWorkspacePanel('sessionMonitorPanel');
            }
        });
    });

    // ================= 3. SYSTEM TABLES RENDERING SUBROUTINES =================
    function refreshDataTablesGrid() {
        const structuralBreachList = ENGINE_STATE.tickets.filter(t => t.status === 'Active' || t.status === 'SCOPE BREACH');
        clientActiveCount.textContent = structuralBreachList.length.toString().padStart(2, '0');
        clientTokenCount.textContent = ENGINE_STATE.tickets.length.toString().padStart(2, '0');
        vendorIncomingCount.textContent = ENGINE_STATE.tickets.filter(t => t.status === 'Pending').length.toString().padStart(2, '0');

        // CLIENT INTERFACE RENDERING STREAM
        clientTasksBody.innerHTML = '';
        ENGINE_STATE.tickets.forEach(ticket => {
            const tableRowNode = document.createElement('tr');
            let structuralBadgeMarkup = 'badge-pending';
            if (ticket.status === 'Active') structuralBadgeMarkup = 'badge-active';
            if (ticket.status === 'SCOPE BREACH') structuralBadgeMarkup = 'badge-breached';
            
            tableRowNode.innerHTML = `
                <td class="bold">${ticket.title}</td>
                <td>${ticket.vendor}</td>
                <td><code class="token-code">${ticket.id}</code></td>
                <td><span class="badge ${structuralBadgeMarkup}">${ticket.status}</span></td>
            `;
            clientTasksBody.appendChild(tableRowNode);
        });

        // VENDOR INTERFACE RENDERING STREAM
        vendorTasksBody.innerHTML = '';
        ENGINE_STATE.tickets.forEach(ticket => {
            if (ticket.status === 'Pending') {
                const tableRowNode = document.createElement('tr');
                tableRowNode.innerHTML = `
                    <td class="bold">${ticket.title}</td>
                    <td>${ticket.client}</td>
                    <td><code class="token-code">${ticket.id}</code></td>
                    <td><button class="btn-table-action fill-hook-trigger" data-token="${ticket.id}">Auto-Inject Key</button></td>
                `;
                vendorTasksBody.appendChild(tableRowNode);
            }
        });

        // Hook up immediate quick injection actions to row controls buttons
        document.querySelectorAll('.fill-hook-trigger').forEach(btn => {
            btn.addEventListener('click', () => {
                inputTokenKey.value = btn.getAttribute('data-token');
                inputTokenKey.focus();
            });
        });
    }

    // ================= 4. SECURE TOKEN GENERATOR CONTROLLER ROUTINES =================
    btnOpenTaskModal.addEventListener('click', () => taskModal.classList.add('open'));
    btnCloseModal.addEventListener('click', () => { taskModal.classList.remove('open'); newTaskForm.reset(); });

    newTaskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const selectionTitle = document.getElementById('taskName').value;
        const selectionVendor = document.getElementById('vendorSelect').value;

        // Formulate deterministic token key signatures
        const alphanumericBlock = Math.random().toString(36).substring(2, 6).toUpperCase();
        const standardNumericBlock = Math.floor(1000 + Math.random() * 9000);
        const uniqueKeySignature = `SCD-${standardNumericBlock}-${alphanumericBlock}`;

        ENGINE_STATE.tickets.unshift({
            id: uniqueKeySignature,
            title: selectionTitle,
            client: 'Maple & Co.',
            vendor: selectionVendor,
            status: 'Pending'
        });

        refreshDataTablesGrid();
        taskModal.classList.remove('open');
        newTaskForm.reset();
    });

    // ================= 5. TECHNICIAN AUTHORIZATION SIGNATURE VERIFICATION HANDLERS =================
    btnValidateToken.addEventListener('click', () => {
        const formattedInputKey = inputTokenKey.value.trim().toUpperCase();
        tokenErrorFeedback.classList.add('hidden');

        // Locate ticket matching target authentication strings parameters
        const matchedTicketObj = ENGINE_STATE.tickets.find(t => t.id === formattedInputKey);

        if (!matchedTicketObj) {
            tokenErrorFeedback.textContent = "❌ Verification Failure: Access key does not exist inside workspace registries.";
            tokenErrorFeedback.classList.remove('hidden');
            return;
        }

        if (matchedTicketObj.status === 'Active') {
            tokenErrorFeedback.textContent = "ℹ️ Execution Notice: This individual instance tracking pipe is currently locked active.";
            tokenErrorFeedback.classList.remove('hidden');
            return;
        }

        // Elevate compliance data parameter mappings
        matchedTicketObj.status = 'Active';
        ENGINE_STATE.selectedSession = matchedTicketObj;

        // Stream telemetry indicators metadata to monitoring screens panels
        lblScopeTask.textContent = matchedTicketObj.title;
        lblScopeVendor.textContent = matchedTicketObj.vendor;
        lblScopeToken.textContent = matchedTicketObj.id;
        emulatorWindowTitle.textContent = `Isolated Frame Pipeline Tunnel Interface [${matchedTicketObj.id}]`;

        // Clear existing system alerts frames metrics
        breachAlertBanner.classList.add('hidden');
        allowedAppWindow.classList.remove('breached-frame');

        refreshDataTablesGrid();
        routeToWorkspacePanel('sessionMonitorPanel');
    });

    // ================= 6. REAL-TIME ISOLATION COMPLIANCE MONITOR CONSOLES =================
    function triggerComplianceViolationAlert() {
        if (!ENGINE_STATE.selectedSession) return;

        // Overwrite standard status parameters definitions in arrays
        ENGINE_STATE.selectedSession.status = 'SCOPE BREACH';
        
        // Throw critical alert overlays indicators layout banners
        breachAlertBanner.classList.remove('hidden');
        allowedAppWindow.classList.add('breached-frame');
        
        refreshDataTablesGrid();
    }

    // Connect trigger triggers hooks items elements components buttons
    btnTriggerBreach.addEventListener('click', triggerComplianceViolationAlert);
    btnSimulateBreach.addEventListener('click', triggerComplianceViolationAlert);

    // Absolute Remote Frame Termination & Forced Lockout Routing Execution
    btnTerminateSession.addEventListener('click', () => {
        if (!ENGINE_STATE.selectedSession) return;

        const connectionTokenToSever = ENGINE_STATE.selectedSession.id;

        // Sever the active data entry parameter entirely out of system memory arrays tracking logs
        ENGINE_STATE.tickets = ENGINE_STATE.tickets.filter(t => t.id !== connectionTokenToSever);
        ENGINE_STATE.selectedSession = null;

        // Visual layout clean structural state sweeps reset parameters variables values
        breachAlertBanner.classList.add('hidden');
        allowedAppWindow.classList.remove('breached-frame');
        inputTokenKey.value = '';

        refreshDataTablesGrid();
        
        alert("🔒 Enforcement System Triggered: Sandboxed execution thread killed cleanly. Virtual pipeline closed.");
        routeToWorkspacePanel(ENGINE_STATE.activeUser.role === 'client' ? 'clientDashboardPanel' : 'vendorDashboardPanel');
    });
});
