import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Download, Calendar } from 'lucide-react';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';

const Reports = () => {
  const { t } = useI18n();
  const { money, opts: fmt } = useFormat();
  const currencyCode = fmt.currency || 'KES';
  const [summary, setSummary] = useState(null);
  const [monthlyData, setMonthlyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    try {
      const [summaryRes, monthlyRes] = await Promise.all([
        axios.get('/api/reports/financial-summary'),
        axios.get(`/api/reports/monthly?year=${selectedYear}&month=${selectedMonth}`)
      ]);
      setSummary(summaryRes.data);
      setMonthlyData(monthlyRes.data);
    } catch (error) {
      console.error('Failed to fetch reports:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleMonthlyChange = () => {
    fetchReports();
  };

  if (loading) {
    return <div>{t('reports.loading')}</div>;
  }

  const pieData = [
    { name: t('contrib.title'), value: summary?.total_contributions || 0 },
    { name: t('reports.loanDisbursed'), value: summary?.total_loans_disbursed || 0 },
    { name: t('welfare.title'), value: summary?.total_welfare || 0 }
  ];

  const COLORS = ['#1a5f2a', '#1565c0', '#e65100'];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('reports.financialTitle')}</h1>
        <button className="btn btn-secondary">
          <Download size={18} /> {t('reports.export')}
        </button>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{money(summary?.total_contributions || 0)}</div>
          <div className="stat-label">{t('dash.totalContributions')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(summary?.total_loans_disbursed || 0)}</div>
          <div className="stat-label">{t('reports.totalLoansDisbursed')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(summary?.total_loans_outstanding || 0)}</div>
          <div className="stat-label">{t('dash.outstandingLoans')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(summary?.total_welfare || 0)}</div>
          <div className="stat-label">{t('dash.welfareFund')}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{t('reports.distribution')}</h3>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{t('reports.monthlySummary')}</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
                {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{new Date(2000, i).toLocaleString('default', { month: 'long' })}</option>
                ))}
              </select>
              <button className="btn btn-sm btn-primary" onClick={handleMonthlyChange}>
                <Calendar size={14} /> {t('reports.go')}
              </button>
            </div>
          </div>
          <div style={{ padding: 20 }}>
            <p><strong>{t('reports.contributionsLabel')}</strong> {money(monthlyData?.contributions?.total || 0)} ({t('reports.txCount', { n: monthlyData?.contributions?.count || 0 })})</p>
            <p style={{ marginTop: 12 }}><strong>{t('reports.loansApproved')}</strong> {money(monthlyData?.loans_approved?.total || 0)} ({t('reports.loanCount', { n: monthlyData?.loans_approved?.count || 0 })})</p>
            <p style={{ marginTop: 12 }}><strong>{t('reports.loanRepayments')}</strong> {money(monthlyData?.loan_repayments?.total || 0)} ({t('reports.paymentCount', { n: monthlyData?.loan_repayments?.count || 0 })})</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Reports;
