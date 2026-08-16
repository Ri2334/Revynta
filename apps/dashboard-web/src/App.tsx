import React, { useState, useEffect } from 'react';
import { 
  BarChart2, 
  Settings, 
  Layers, 
  MessageSquare, 
  Key, 
  Activity, 
  Send, 
  User, 
  LogOut, 
  Plus, 
  RotateCw, 
  Trash2, 
  CheckCircle, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  Lock,
  Pause,
  Play
} from 'lucide-react';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:3001/api/v1';

export default function App() {
  // Authentication State
  const [user, setUser] = useState<any>(null);
  const [stores, setStores] = useState<any[]>([]);
  const [activeStoreId, setActiveStoreId] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(true);

  // Router-like state
  const [currentTab, setCurrentTab] = useState<'overview' | 'campaigns' | 'whatsapp' | 'apikeys' | 'messages' | 'audit' | 'settings'>('overview');

  // Form State - Auth
  const [isRegister, setIsRegister] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authFirstName, setAuthFirstName] = useState('');
  const [authLastName, setAuthLastName] = useState('');
  const [authOrgName, setAuthOrgName] = useState('');
  const [authStoreName, setAuthStoreName] = useState('');
  const [authStoreDomain, setAuthStoreDomain] = useState('');
  const [authError, setAuthError] = useState('');

  // Dashboard Data
  const [overviewStats, setOverviewStats] = useState<any>(null);
  const [intentStats, setIntentStats] = useState<any>(null);
  const [funnelStats, setFunnelStats] = useState<any>(null);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [messageLogs, setMessageLogs] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [activeStoreDetail, setActiveStoreDetail] = useState<any>(null);
  const [whatsappIntegration, setWhatsappIntegration] = useState<any>(null);

  // Form State - Campaign Editor
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<any>(null);
  const [campName, setCampName] = useState('');
  const [campMinIntent, setCampMinIntent] = useState(70);
  const [campInactivity, setCampInactivity] = useState(30);
  const [campTemplate, setCampTemplate] = useState('browse-recovery-whatsapp');
  const [campCooldown, setCampCooldown] = useState(86400);
  const [campError, setCampError] = useState('');

  // Form State - WhatsApp Settings
  const [waPhoneId, setWaPhoneId] = useState('');
  const [waAccessToken, setWaAccessToken] = useState('');
  const [waIsMock, setWaIsMock] = useState(true);
  const [waSuccessMsg, setWaSuccessMsg] = useState('');
  const [waErrorMsg, setWaErrorMsg] = useState('');

  // Form State - API Keys
  const [newKeyName, setNewKeyName] = useState('');
  const [exposedRawKey, setExposedRawKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState('');

  // Form State - Store Settings
  const [storeNameEdit, setStoreNameEdit] = useState('');
  const [storeDomainEdit, setStoreDomainEdit] = useState('');
  const [storeSuccessMsg, setStoreSuccessMsg] = useState('');

  // Global UI states
  const [globalLoading, setGlobalLoading] = useState(false);

  // Check user session on mount
  useEffect(() => {
    fetchSession();
  }, []);

  // Fetch data when active store changes
  useEffect(() => {
    if (activeStoreId) {
      refreshData();
    }
  }, [activeStoreId, currentTab]);

  const getAuthHeaders = (extraHeaders: Record<string, string> = {}) => {
    const token = localStorage.getItem('revynta_token');
    const headers: Record<string, string> = { ...extraHeaders };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  };

  const fetchSession = async () => {
    setAuthLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/me`, { 
        headers: getAuthHeaders(),
        credentials: 'include' 
      });
      if (res.ok) {
        const body = await res.json();
        setUser(body.data);
        // Fetch accessible stores
        const storesRes = await fetch(`${API_BASE}/stores`, { 
          headers: getAuthHeaders(),
          credentials: 'include' 
        });
        if (storesRes.ok) {
          const storesBody = await storesRes.json();
          setStores(storesBody.data);
          // Set initial active store context
          const currentStore = storesBody.data.find((s: any) => s.id === body.data.activeStoreId) || storesBody.data[0];
          if (currentStore) {
            setActiveStoreId(currentStore.id);
          }
        }
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error('Session check failed', err);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const url = isRegister ? `${API_BASE}/auth/register` : `${API_BASE}/auth/login`;
    const payload = isRegister ? {
      email: authEmail,
      password: authPassword,
      firstName: authFirstName,
      lastName: authLastName,
      organizationName: authOrgName,
      storeName: authStoreName,
      storeDomain: authStoreDomain
    } : { email: authEmail, password: authPassword };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      });
      const body = await res.json();
      if (!res.ok) {
        setAuthError(body.error?.message || 'Authentication failed');
      } else {
        if (body.data?.token) {
          localStorage.setItem('revynta_token', body.data.token);
        }
        // Clear forms and reload session
        setAuthEmail('');
        setAuthPassword('');
        setAuthFirstName('');
        setAuthLastName('');
        setAuthOrgName('');
        setAuthStoreName('');
        setAuthStoreDomain('');
        await fetchSession();
      }
    } catch (err) {
      setAuthError('Connection failed to Merchant API');
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { 
        method: 'POST', 
        headers: getAuthHeaders(),
        credentials: 'include' 
      });
      localStorage.removeItem('revynta_token');
      setUser(null);
      setStores([]);
      setActiveStoreId('');
      setCurrentTab('overview');
    } catch (err) {
      console.error(err);
    }
  };

  const refreshData = async () => {
    if (!activeStoreId) return;
    setGlobalLoading(true);
    const headers = getAuthHeaders({ 'x-store-id': activeStoreId });

    try {
      if (currentTab === 'overview') {
        const [overviewRes, intentRes, funnelRes] = await Promise.all([
          fetch(`${API_BASE}/analytics/overview`, { headers, credentials: 'include' }),
          fetch(`${API_BASE}/analytics/intent`, { headers, credentials: 'include' }),
          fetch(`${API_BASE}/analytics/funnel`, { headers, credentials: 'include' }),
        ]);

        if (overviewRes.ok) setOverviewStats((await overviewRes.json()).data);
        if (intentRes.ok) setIntentStats((await intentRes.json()).data);
        if (funnelRes.ok) setFunnelStats((await funnelRes.json()).data);
      }

      if (currentTab === 'campaigns') {
        const res = await fetch(`${API_BASE}/campaigns`, { headers, credentials: 'include' });
        if (res.ok) setCampaigns((await res.json()).data);
      }

      if (currentTab === 'apikeys') {
        const res = await fetch(`${API_BASE}/api-keys`, { headers, credentials: 'include' });
        if (res.ok) setApiKeys((await res.json()).data);
      }

      if (currentTab === 'messages') {
        const res = await fetch(`${API_BASE}/messages?page=1&limit=50`, { headers, credentials: 'include' });
        if (res.ok) setMessageLogs((await res.json()).data);
      }

      if (currentTab === 'audit') {
        const res = await fetch(`${API_BASE}/audit-logs?page=1&limit=50`, { headers, credentials: 'include' });
        if (res.ok) setAuditLogs((await res.json()).data);
      }

      if (currentTab === 'whatsapp') {
        const res = await fetch(`${API_BASE}/integrations/whatsapp`, { headers, credentials: 'include' });
        if (res.ok) {
          const body = await res.json();
          setWhatsappIntegration(body.data);
          if (body.data) {
            setWaPhoneId(body.data.phoneNumberId || '');
            setWaIsMock(body.data.isMock ?? true);
          }
        }
      }

      if (currentTab === 'settings') {
        const res = await fetch(`${API_BASE}/stores/${activeStoreId}`, { headers, credentials: 'include' });
        if (res.ok) {
          const body = await res.json();
          setActiveStoreDetail(body.data);
          setStoreNameEdit(body.data.name);
          setStoreDomainEdit(body.data.domain);
        }
      }
    } catch (err) {
      console.error('Failed to reload tab data', err);
    } finally {
      setGlobalLoading(false);
    }
  };

  // Campaign management operations
  const handleCreateOrUpdateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    setCampError('');
    const headers = { 'Content-Type': 'application/json', 'x-store-id': activeStoreId };
    
    if (campInactivity <= 0 || campMinIntent < 0 || campMinIntent > 100 || campCooldown < 0) {
      setCampError('Invalid numeric range limits');
      return;
    }

    const payload = {
      name: campName,
      triggerType: 'browse_abandonment',
      inactivityDurationMinutes: Number(campInactivity),
      minIntentScore: Number(campMinIntent),
      communicationChannel: 'whatsapp',
      templateId: campTemplate,
      cooldownSeconds: Number(campCooldown),
    };

    try {
      const url = editingCampaign ? `${API_BASE}/campaigns/${editingCampaign.id}` : `${API_BASE}/campaigns`;
      const method = editingCampaign ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
        credentials: 'include'
      });

      if (!res.ok) {
        const body = await res.json();
        setCampError(body.error?.message || 'Failed to persist campaign');
      } else {
        setShowCampaignModal(false);
        setEditingCampaign(null);
        refreshData();
      }
    } catch (err) {
      setCampError('Error saving campaign');
    }
  };

  const handleToggleCampaign = async (id: string) => {
    try {
      await fetch(`${API_BASE}/campaigns/${id}/toggle`, {
        method: 'POST',
        headers: { 'x-store-id': activeStoreId },
        credentials: 'include'
      });
      refreshData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    if (!confirm('Are you sure you want to archive this campaign?')) return;
    try {
      await fetch(`${API_BASE}/campaigns/${id}`, {
        method: 'DELETE',
        headers: { 'x-store-id': activeStoreId },
        credentials: 'include'
      });
      refreshData();
    } catch (err) {
      console.error(err);
    }
  };

  // WhatsApp configuration operations
  const handleSaveWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault();
    setWaSuccessMsg('');
    setWaErrorMsg('');
    const headers = { 'Content-Type': 'application/json', 'x-store-id': activeStoreId };

    try {
      const res = await fetch(`${API_BASE}/integrations/whatsapp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phoneNumberId: waPhoneId,
          accessToken: waAccessToken,
          isMock: waIsMock
        }),
        credentials: 'include'
      });

      if (res.ok) {
        setWaSuccessMsg('WhatsApp connection saved successfully!');
        setWaAccessToken('');
        refreshData();
      } else {
        const body = await res.json();
        setWaErrorMsg(body.error?.message || 'Connection configuration failed');
      }
    } catch (err) {
      setWaErrorMsg('Network failure setting credentials');
    }
  };

  const handleToggleWhatsApp = async () => {
    try {
      await fetch(`${API_BASE}/integrations/whatsapp/toggle`, {
        method: 'POST',
        headers: { 'x-store-id': activeStoreId },
        credentials: 'include'
      });
      refreshData();
    } catch (err) {
      console.error(err);
    }
  };

  // API Key operations
  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError('');
    setExposedRawKey(null);
    const headers = { 'Content-Type': 'application/json', 'x-store-id': activeStoreId };

    try {
      const res = await fetch(`${API_BASE}/api-keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newKeyName }),
        credentials: 'include'
      });

      if (res.ok) {
        const body = await res.json();
        setExposedRawKey(body.data.rawKey);
        setNewKeyName('');
        refreshData();
      } else {
        const body = await res.json();
        setKeyError(body.error?.message || 'API key creation failed');
      }
    } catch (err) {
      setKeyError('Connection error');
    }
  };

  const handleRevokeApiKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key?')) return;
    try {
      await fetch(`${API_BASE}/api-keys/${id}`, {
        method: 'DELETE',
        headers: { 'x-store-id': activeStoreId },
        credentials: 'include'
      });
      refreshData();
    } catch (err) {
      console.error(err);
    }
  };

  // Update Store details
  const handleSaveStoreSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setStoreSuccessMsg('');
    const headers = { 'Content-Type': 'application/json', 'x-store-id': activeStoreId };

    try {
      const res = await fetch(`${API_BASE}/stores/${activeStoreId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ name: storeNameEdit, domain: storeDomainEdit }),
        credentials: 'include'
      });

      if (res.ok) {
        setStoreSuccessMsg('Store configuration saved successfully!');
        // Refresh local store context list
        fetchSession();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0b0f19] flex flex-col items-center justify-center text-gray-400">
        <RotateCw className="w-10 h-10 animate-spin text-brand-500 mb-4" />
        <p className="text-sm font-medium tracking-wider">LOADING REVYNTA CONTROL PLANE...</p>
      </div>
    );
  }

  // --- Auth View (Login / Register) ---
  if (!user) {
    return (
      <div className="min-h-screen bg-[#0b0f19] flex items-center justify-center px-4 py-12">
        <div className="max-w-md w-full space-y-8 bg-[#111827] border border-gray-800 p-8 rounded-2xl shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-brand-500 to-indigo-600"></div>
          
          <div className="text-center">
            <h2 className="text-3xl font-extrabold text-white tracking-tight">Revynta</h2>
            <p className="mt-2 text-sm text-gray-400">
              {isRegister ? 'Create your multi-tenant merchant workspace' : 'Sign in to your merchant dashboard'}
            </p>
          </div>

          <form className="mt-8 space-y-6" onSubmit={handleAuth}>
            {authError && (
              <div className="bg-red-900/30 border border-red-500/50 rounded-xl p-4 flex items-start space-x-3 text-red-200 text-sm">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <div className="space-y-4">
              {isRegister && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">First Name</label>
                      <input
                        type="text"
                        required
                        className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                        placeholder="John"
                        value={authFirstName}
                        onChange={(e) => setAuthFirstName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Last Name</label>
                      <input
                        type="text"
                        required
                        className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                        placeholder="Doe"
                        value={authLastName}
                        onChange={(e) => setAuthLastName(e.target.value)}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Organization Name</label>
                    <input
                      type="text"
                      required
                      className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                      placeholder="My Corporation"
                      value={authOrgName}
                      onChange={(e) => setAuthOrgName(e.target.value)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Store Name</label>
                      <input
                        type="text"
                        required
                        className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                        placeholder="Apparel Shop"
                        value={authStoreName}
                        onChange={(e) => setAuthStoreName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Store Domain</label>
                      <input
                        type="text"
                        required
                        className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                        placeholder="apparel.com"
                        value={authStoreDomain}
                        onChange={(e) => setAuthStoreDomain(e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  placeholder="name@company.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Password</label>
                <input
                  type="password"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  placeholder="••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                className="w-full py-3.5 px-4 bg-brand-500 hover:bg-brand-600 focus:outline-none text-white text-sm font-semibold rounded-xl transition duration-150 ease-in-out shadow-lg shadow-brand-500/20"
              >
                {isRegister ? 'Register Workspace' : 'Sign In'}
              </button>
            </div>

            <div className="text-center mt-4">
              <button
                type="button"
                className="text-xs text-brand-400 hover:text-brand-300 font-medium"
                onClick={() => {
                  setIsRegister(!isRegister);
                  setAuthError('');
                }}
              >
                {isRegister ? 'Already have an account? Log in' : "Don't have an account? Register workspace"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // --- Authenticated Merchant View ---
  return (
    <div className="min-h-screen bg-[#0b0f19] flex">
      
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-[#111827] border-r border-gray-800 flex flex-col justify-between flex-shrink-0">
        <div>
          <div className="h-16 flex items-center px-6 border-b border-gray-800">
            <span className="text-xl font-bold tracking-tight text-white">Revynta Control</span>
          </div>

          <div className="p-4">
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Active Store Context</label>
            <select
              className="w-full bg-[#1f2937] border border-gray-700 text-white rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-brand-500 cursor-pointer"
              value={activeStoreId}
              onChange={(e) => setActiveStoreId(e.target.value)}
            >
              {stores.map((s: any) => (
                <option key={s.id} value={s.id}>{s.name} ({s.domain})</option>
              ))}
            </select>
          </div>

          <nav className="px-3 mt-4 space-y-1">
            <button
              onClick={() => setCurrentTab('overview')}
              className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                currentTab === 'overview' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <BarChart2 className="w-5 h-5" />
              <span>Dashboard</span>
            </button>

            <button
              onClick={() => setCurrentTab('campaigns')}
              className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                currentTab === 'campaigns' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <Layers className="w-5 h-5" />
              <span>Campaigns</span>
            </button>

            <button
              onClick={() => setCurrentTab('whatsapp')}
              className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                currentTab === 'whatsapp' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <MessageSquare className="w-5 h-5" />
              <span>WhatsApp API</span>
            </button>

            <button
              onClick={() => setCurrentTab('apikeys')}
              className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                currentTab === 'apikeys' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <Key className="w-5 h-5" />
              <span>API Keys</span>
            </button>

            <button
              onClick={() => setCurrentTab('messages')}
              className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                currentTab === 'messages' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <Send className="w-5 h-5" />
              <span>Message History</span>
            </button>

            {['owner', 'admin'].includes(user.role) && (
              <button
                onClick={() => setCurrentTab('audit')}
                className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                  currentTab === 'audit' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <Activity className="w-5 h-5" />
                <span>Audit Logs</span>
              </button>
            )}

            <button
              onClick={() => setCurrentTab('settings')}
              className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition ${
                currentTab === 'settings' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/10' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <Settings className="w-5 h-5" />
              <span>Settings</span>
            </button>
          </nav>
        </div>

        <div className="p-4 border-t border-gray-800">
          <div className="flex items-center justify-between mb-3 px-2">
            <div className="flex items-center space-x-2">
              <User className="w-4 h-4 text-brand-400" />
              <span className="text-xs font-semibold text-gray-300 truncate max-w-[120px]">{user.email}</span>
            </div>
            <span className="px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider rounded bg-brand-500/20 text-brand-300 border border-brand-500/30">
              {user.role}
            </span>
          </div>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 py-2 px-4 border border-gray-800 rounded-xl hover:bg-gray-800 text-xs font-semibold text-red-400 hover:text-red-300 transition"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto p-8 relative">
        {globalLoading && (
          <div className="absolute top-4 right-4 flex items-center space-x-2 text-xs text-brand-400">
            <RotateCw className="w-4 h-4 animate-spin" />
            <span>Refreshing...</span>
          </div>
        )}

        {/* --- Tab: Overview / Dashboard --- */}
        {currentTab === 'overview' && (
          <div className="space-y-8">
            <div>
              <h1 className="text-2xl font-extrabold text-white tracking-tight">Overview Dashboard</h1>
              <p className="text-sm text-gray-400">Real-time metrics, shopper segments and conversion tracking funnels</p>
            </div>

            {/* Overview Stats Cards */}
            {overviewStats ? (
              <div className="grid grid-cols-4 gap-6">
                <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-widest block">Total Campaigns Dispatched</span>
                  <span className="text-3xl font-extrabold text-white mt-2 block">{overviewStats.total}</span>
                </div>
                <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-widest block">Delivered Messages</span>
                  <span className="text-3xl font-extrabold text-white mt-2 block">{overviewStats.delivered + overviewStats.read}</span>
                </div>
                <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-widest block">Delivery Success Rate</span>
                  <span className="text-3xl font-extrabold text-brand-400 mt-2 block">
                    {(overviewStats.deliveryRate * 100).toFixed(2)}%
                  </span>
                </div>
                <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-widest block">Read Rate</span>
                  <span className="text-3xl font-extrabold text-indigo-400 mt-2 block">
                    {(overviewStats.readRate * 100).toFixed(2)}%
                  </span>
                </div>
              </div>
            ) : (
              <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 text-center text-gray-500">
                Metrics not loaded. Make sure the backend service is running.
              </div>
            )}

            {/* Visual Charts Section */}
            <div className="grid grid-cols-3 gap-6">
              
              {/* Intent Segment Distribution */}
              <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 col-span-1">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-6">Intent Distribution</h3>
                {intentStats ? (
                  <div className="space-y-4">
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>High Intent (70-100)</span>
                        <span className="font-semibold text-white">{intentStats.high}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-2.5 rounded-full overflow-hidden">
                        <div className="bg-brand-500 h-full" style={{ width: `${Math.min(100, (intentStats.high / (intentStats.high + intentStats.medium + intentStats.low || 1)) * 100)}%` }}></div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Medium Intent (30-69)</span>
                        <span className="font-semibold text-white">{intentStats.medium}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-2.5 rounded-full overflow-hidden">
                        <div className="bg-indigo-500 h-full" style={{ width: `${Math.min(100, (intentStats.medium / (intentStats.high + intentStats.medium + intentStats.low || 1)) * 100)}%` }}></div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Low Intent (0-29)</span>
                        <span className="font-semibold text-white">{intentStats.low}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-2.5 rounded-full overflow-hidden">
                        <div className="bg-gray-600 h-full" style={{ width: `${Math.min(100, (intentStats.low / (intentStats.high + intentStats.medium + intentStats.low || 1)) * 100)}%` }}></div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">Distribution metrics loading...</p>
                )}
              </div>

              {/* ClickHouse Conversion Funnel */}
              <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 col-span-2">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-6">Shopper Conversion Funnel (ClickHouse)</h3>
                {funnelStats ? (
                  <div className="space-y-4">
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Stage 1: Unique Inbound Shoppers</span>
                        <span className="font-semibold text-white">{funnelStats.stage_unique_shoppers}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-3.5 rounded-lg overflow-hidden">
                        <div className="bg-brand-500 h-full flex items-center justify-end px-2 text-[9px] font-bold text-white" style={{ width: '100%' }}>100%</div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Stage 2: Product Detail Views</span>
                        <span className="font-semibold text-white">{funnelStats.stage_product_views}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-3.5 rounded-lg overflow-hidden">
                        <div className="bg-brand-400 h-full flex items-center justify-end px-2 text-[9px] font-bold text-white" style={{ width: `${Math.min(100, (funnelStats.stage_product_views / (funnelStats.stage_unique_shoppers || 1)) * 100)}%` }}>
                          {((funnelStats.stage_product_views / (funnelStats.stage_unique_shoppers || 1)) * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Stage 3: Cart Additions</span>
                        <span className="font-semibold text-white">{funnelStats.stage_cart_adds}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-3.5 rounded-lg overflow-hidden">
                        <div className="bg-indigo-500 h-full flex items-center justify-end px-2 text-[9px] font-bold text-white" style={{ width: `${Math.min(100, (funnelStats.stage_cart_adds / (funnelStats.stage_unique_shoppers || 1)) * 100)}%` }}>
                          {((funnelStats.stage_cart_adds / (funnelStats.stage_unique_shoppers || 1)) * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Stage 4: Confirmed Purchases</span>
                        <span className="font-semibold text-white">{funnelStats.stage_purchases}</span>
                      </div>
                      <div className="w-full bg-gray-800 h-3.5 rounded-lg overflow-hidden">
                        <div className="bg-emerald-500 h-full flex items-center justify-end px-2 text-[9px] font-bold text-white" style={{ width: `${Math.min(100, (funnelStats.stage_purchases / (funnelStats.stage_unique_shoppers || 1)) * 100)}%` }}>
                          {((funnelStats.stage_purchases / (funnelStats.stage_unique_shoppers || 1)) * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">Funnel aggregates loading...</p>
                )}
              </div>

            </div>
          </div>
        )}

        {/* --- Tab: Campaigns --- */}
        {currentTab === 'campaigns' && (
          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-extrabold text-white tracking-tight">Campaigns</h1>
                <p className="text-sm text-gray-400">Define thresholds, channels and templates for browse abandonment recovery</p>
              </div>
              
              <button
                onClick={() => {
                  setEditingCampaign(null);
                  setCampName('');
                  setCampMinIntent(70);
                  setCampInactivity(30);
                  setCampTemplate('browse-recovery-whatsapp');
                  setCampCooldown(86400);
                  setCampError('');
                  setShowCampaignModal(true);
                }}
                className="flex items-center space-x-2 py-2.5 px-4 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold transition"
              >
                <Plus className="w-4 h-4" />
                <span>Create Campaign</span>
              </button>
            </div>

            <div className="bg-[#111827] border border-gray-800 rounded-2xl overflow-hidden">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 font-semibold text-xs uppercase tracking-wider bg-gray-900/50">
                    <th className="py-4 px-6">Name</th>
                    <th className="py-4 px-6">Status</th>
                    <th className="py-4 px-6">Inactivity (min)</th>
                    <th className="py-4 px-6">Min Intent</th>
                    <th className="py-4 px-6">Channel</th>
                    <th className="py-4 px-6">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {campaigns.map((camp: any) => (
                    <tr key={camp.id} className="hover:bg-gray-800/30 text-gray-300">
                      <td className="py-4 px-6 font-semibold text-white">{camp.name}</td>
                      <td className="py-4 px-6">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase border ${
                          camp.status === 'active' 
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                            : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                        }`}>
                          {camp.status}
                        </span>
                      </td>
                      <td className="py-4 px-6">{camp.inactivity_duration_minutes}</td>
                      <td className="py-4 px-6 font-medium">{camp.min_intent_score}</td>
                      <td className="py-4 px-6 font-medium uppercase tracking-wider text-xs">{camp.communication_channel}</td>
                      <td className="py-4 px-6 space-x-2">
                        <button
                          onClick={() => handleToggleCampaign(camp.id)}
                          className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition"
                          title={camp.status === 'active' ? 'Pause Campaign' : 'Resume Campaign'}
                        >
                          {camp.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => {
                            setEditingCampaign(camp);
                            setCampName(camp.name);
                            setCampMinIntent(camp.min_intent_score);
                            setCampInactivity(camp.inactivity_duration_minutes);
                            setCampTemplate(camp.template_id);
                            setCampCooldown(camp.cooldown_seconds);
                            setCampError('');
                            setShowCampaignModal(true);
                          }}
                          className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition text-xs font-semibold"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteCampaign(camp.id)}
                          className="p-1.5 hover:bg-gray-700 rounded-lg text-red-400 hover:text-red-300 transition"
                          title="Archive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {campaigns.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-500">
                        No campaigns configured. Click 'Create Campaign' to start.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Campaign Modal Editor */}
            {showCampaignModal && (
              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                <div className="bg-[#111827] border border-gray-800 max-w-md w-full rounded-2xl overflow-hidden shadow-2xl relative">
                  <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-brand-500 to-indigo-600"></div>
                  
                  <div className="p-6 border-b border-gray-800">
                    <h3 className="text-base font-extrabold text-white">{editingCampaign ? 'Edit Campaign Configuration' : 'Create Campaign'}</h3>
                  </div>

                  <form onSubmit={handleCreateOrUpdateCampaign}>
                    <div className="p-6 space-y-4">
                      {campError && (
                        <div className="text-red-400 text-xs bg-red-950/20 border border-red-900 rounded-lg p-3">
                          {campError}
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Campaign Name</label>
                        <input
                          type="text"
                          required
                          className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                          placeholder="Browse Abandonment Recovery"
                          value={campName}
                          onChange={(e) => setCampName(e.target.value)}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Inactivity Limit (min)</label>
                          <input
                            type="number"
                            required
                            min="1"
                            className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                            value={campInactivity}
                            onChange={(e) => setCampInactivity(Number(e.target.value))}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Min Intent Score</label>
                          <input
                            type="number"
                            required
                            min="0"
                            max="100"
                            className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                            value={campMinIntent}
                            onChange={(e) => setCampMinIntent(Number(e.target.value))}
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">WhatsApp Template ID</label>
                        <input
                          type="text"
                          required
                          className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                          value={campTemplate}
                          onChange={(e) => setCampTemplate(e.target.value)}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Cooldown Duration (sec)</label>
                        <input
                          type="number"
                          required
                          min="0"
                          className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                          value={campCooldown}
                          onChange={(e) => setCampCooldown(Number(e.target.value))}
                        />
                      </div>
                    </div>

                    <div className="p-6 border-t border-gray-800 flex justify-end space-x-3 bg-gray-900/30">
                      <button
                        type="button"
                        onClick={() => setShowCampaignModal(false)}
                        className="py-2.5 px-4 border border-gray-700 rounded-xl hover:bg-gray-800 text-xs font-semibold text-gray-400 transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="py-2.5 px-4 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold transition"
                      >
                        {editingCampaign ? 'Save Changes' : 'Create Campaign'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- Tab: WhatsApp settings --- */}
        {currentTab === 'whatsapp' && (
          <div className="space-y-8 max-w-2xl">
            <div>
              <h1 className="text-2xl font-extrabold text-white tracking-tight">WhatsApp Gateway</h1>
              <p className="text-sm text-gray-400">Configure credentials and tokens for Meta Cloud API integration</p>
            </div>

            {whatsappIntegration && (
              <div className="bg-[#111827] border border-gray-800 rounded-2xl p-6 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-widest block">Integration Status</span>
                  <div className="flex items-center space-x-2 mt-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${whatsappIntegration.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-gray-600'}`}></span>
                    <span className="text-sm font-semibold text-white capitalize">{whatsappIntegration.status}</span>
                  </div>
                </div>

                <button
                  onClick={handleToggleWhatsApp}
                  className={`py-2 px-4 border rounded-xl text-xs font-semibold transition ${
                    whatsappIntegration.status === 'active' 
                      ? 'border-yellow-600 text-yellow-400 hover:bg-yellow-950/20' 
                      : 'border-emerald-600 text-emerald-400 hover:bg-emerald-950/20'
                  }`}
                >
                  {whatsappIntegration.status === 'active' ? 'Disable Integration' : 'Enable Integration'}
                </button>
              </div>
            )}

            <form onSubmit={handleSaveWhatsApp} className="bg-[#111827] border border-gray-800 rounded-2xl p-6 space-y-6">
              {waSuccessMsg && (
                <div className="bg-emerald-950/20 border border-emerald-900 rounded-xl p-4 flex items-start space-x-3 text-emerald-200 text-sm">
                  <CheckCircle className="w-5 h-5 flex-shrink-0" />
                  <span>{waSuccessMsg}</span>
                </div>
              )}
              {waErrorMsg && (
                <div className="bg-red-950/20 border border-red-900 rounded-xl p-4 flex items-start space-x-3 text-red-200 text-sm">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span>{waErrorMsg}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">WhatsApp Phone ID</label>
                <input
                  type="text"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  placeholder="e.g. 109677328511"
                  value={waPhoneId}
                  onChange={(e) => setWaPhoneId(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Access Token / Secret</label>
                <input
                  type="password"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  placeholder="••••••••••••••••••••••••••••••••"
                  value={waAccessToken}
                  onChange={(e) => setWaAccessToken(e.target.value)}
                />
                <span className="text-[10px] text-gray-500 mt-1 block">Tokens are stored encrypted using AES-256-GCM. Decrypted secrets are never returned.</span>
              </div>

              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="waIsMock"
                  className="bg-[#1f2937] border-gray-700 rounded text-brand-500 w-4 h-4 cursor-pointer"
                  checked={waIsMock}
                  onChange={(e) => setWaIsMock(e.target.checked)}
                />
                <label htmlFor="waIsMock" className="text-xs font-semibold text-gray-300 cursor-pointer">
                  Use Mock delivery environment (recommended for local test development)
                </label>
              </div>

              <button
                type="submit"
                className="py-2.5 px-4 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold transition"
              >
                Save Connectivity Settings
              </button>
            </form>
          </div>
        )}

        {/* --- Tab: API Keys --- */}
        {currentTab === 'apikeys' && (
          <div className="space-y-8 max-w-3xl">
            <div>
              <h1 className="text-2xl font-extrabold text-white tracking-tight">Ingestion API Keys</h1>
              <p className="text-sm text-gray-400">Generate and manage credential mapping tokens for your client-side tracking SDK</p>
            </div>

            {exposedRawKey && (
              <div className="bg-yellow-950/20 border border-yellow-900/50 rounded-2xl p-6 space-y-3 relative overflow-hidden">
                <div className="absolute top-0 left-0 bottom-0 w-1 bg-yellow-600"></div>
                <h4 className="text-sm font-bold text-yellow-400 flex items-center space-x-2">
                  <Lock className="w-4 h-4" />
                  <span>Important: Copy your API Key now</span>
                </h4>
                <p className="text-xs text-gray-400">
                  This key will only be shown to you **exactly once** for security. It cannot be recovered after this session closes.
                </p>
                <div className="flex items-center space-x-2 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 text-sm font-mono text-white select-all">
                  <span>{exposedRawKey}</span>
                </div>
              </div>
            )}

            <form onSubmit={handleCreateApiKey} className="bg-[#111827] border border-gray-800 rounded-2xl p-6 space-y-4">
              {keyError && <p className="text-red-400 text-xs">{keyError}</p>}
              
              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Key Description Name</label>
                <input
                  type="text"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  placeholder="e.g. Production Web SDK Ingestion Key"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>

              <button
                type="submit"
                className="py-2.5 px-4 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold transition"
              >
                Generate Key Token
              </button>
            </form>

            <div className="bg-[#111827] border border-gray-800 rounded-2xl overflow-hidden">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 font-semibold text-xs uppercase tracking-wider bg-gray-900/50">
                    <th className="py-4 px-6">Name</th>
                    <th className="py-4 px-6">Key Prefix</th>
                    <th className="py-4 px-6">Status</th>
                    <th className="py-4 px-6">Created At</th>
                    <th className="py-4 px-6">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {apiKeys.map((k: any) => (
                    <tr key={k.id} className="hover:bg-gray-800/30 text-gray-300">
                      <td className="py-4 px-6 font-semibold text-white">{k.name}</td>
                      <td className="py-4 px-6 font-mono text-xs">{k.key_prefix}...</td>
                      <td className="py-4 px-6">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase border ${
                          k.status === 'active' 
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                        }`}>
                          {k.status}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-xs text-gray-400">{new Date(k.created_at).toLocaleString()}</td>
                      <td className="py-4 px-6">
                        {k.status === 'active' && (
                          <button
                            onClick={() => handleRevokeApiKey(k.id)}
                            className="p-1 hover:bg-gray-700 rounded text-red-400 hover:text-red-300 transition text-xs font-semibold"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {apiKeys.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-gray-500">
                        No API Keys created. Use the form above to generate one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- Tab: Messages --- */}
        {currentTab === 'messages' && (
          <div className="space-y-8">
            <div>
              <h1 className="text-2xl font-extrabold text-white tracking-tight">Message Dispatch History</h1>
              <p className="text-sm text-gray-400">View logged outbound recovery dispatches (destination numbers are masked by default)</p>
            </div>

            <div className="bg-[#111827] border border-gray-800 rounded-2xl overflow-hidden">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 font-semibold text-xs uppercase tracking-wider bg-gray-900/50">
                    <th className="py-4 px-6">Message ID</th>
                    <th className="py-4 px-6">Campaign ID</th>
                    <th className="py-4 px-6">Status</th>
                    <th className="py-4 px-6">Destination</th>
                    <th className="py-4 px-6">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {messageLogs.map((log: any) => (
                    <tr key={log.id} className="hover:bg-gray-800/30 text-gray-300">
                      <td className="py-4 px-6 font-mono text-xs">{log.id}</td>
                      <td className="py-4 px-6 font-mono text-xs">{log.campaignId}</td>
                      <td className="py-4 px-6">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase border ${
                          log.status === 'read' 
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                            : log.status === 'delivered' 
                            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                            : log.status === 'failed' 
                            ? 'bg-red-500/10 text-red-400 border-red-500/20'
                            : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                        }`}>
                          {log.status}
                        </span>
                      </td>
                      <td className="py-4 px-6 font-mono text-xs text-gray-500">xxxxxxxxxxxx (Masked)</td>
                      <td className="py-4 px-6 text-xs text-gray-400">{new Date(log.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                  {messageLogs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-gray-500">
                        No messages logged for this store context.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- Tab: Audit Logs --- */}
        {currentTab === 'audit' && (
          <div className="space-y-8">
            <div>
              <h1 className="text-2xl font-extrabold text-white tracking-tight">Audit Trail</h1>
              <p className="text-sm text-gray-400">Security history and administrative configuration logs</p>
            </div>

            <div className="bg-[#111827] border border-gray-800 rounded-2xl overflow-hidden">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 font-semibold text-xs uppercase tracking-wider bg-gray-900/50">
                    <th className="py-4 px-6">Action</th>
                    <th className="py-4 px-6">Actor ID</th>
                    <th className="py-4 px-6">Resource ID</th>
                    <th className="py-4 px-6">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {auditLogs.map((log: any) => (
                    <tr key={log.id} className="hover:bg-gray-800/30 text-gray-300">
                      <td className="py-4 px-6 font-semibold text-white uppercase tracking-wider text-xs">{log.action}</td>
                      <td className="py-4 px-6 font-mono text-xs text-gray-500">{log.user_id || 'system'}</td>
                      <td className="py-4 px-6 font-mono text-xs text-gray-500">{log.resource_id}</td>
                      <td className="py-4 px-6 text-xs text-gray-400">{new Date(log.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {auditLogs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-gray-500">
                        No audit logs recorded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- Tab: Settings --- */}
        {currentTab === 'settings' && (
          <div className="space-y-8 max-w-2xl">
            <div>
              <h1 className="text-2xl font-extrabold text-white tracking-tight">Store Settings</h1>
              <p className="text-sm text-gray-400">Manage basic parameters and metadata for this store context</p>
            </div>

            <form onSubmit={handleSaveStoreSettings} className="bg-[#111827] border border-gray-800 rounded-2xl p-6 space-y-6">
              {storeSuccessMsg && (
                <div className="bg-emerald-950/20 border border-emerald-900 rounded-xl p-4 flex items-start space-x-3 text-emerald-200 text-sm">
                  <CheckCircle className="w-5 h-5 flex-shrink-0" />
                  <span>{storeSuccessMsg}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Store Name</label>
                <input
                  type="text"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  value={storeNameEdit}
                  onChange={(e) => setStoreNameEdit(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase mb-1">Store Domain</label>
                <input
                  type="text"
                  required
                  className="w-full bg-[#1f2937] border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 text-sm"
                  value={storeDomainEdit}
                  onChange={(e) => setStoreDomainEdit(e.target.value)}
                />
              </div>

              <button
                type="submit"
                className="py-2.5 px-4 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-xs font-semibold transition"
              >
                Save Store Settings
              </button>
            </form>
          </div>
        )}

      </main>
    </div>
  );
}
