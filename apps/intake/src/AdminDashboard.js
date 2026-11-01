// AdminDashboard extracted from RoleDashboards.js for maintainability.
// Contains the admin/teacher dashboard with KPIs, segmentation, hotspots,
// action plans, and student report tabs.

import { useMemo, useState, useEffect } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import NotebookLoader from './NotebookLoader';
import {
  normalizeSubject,
  deriveDefaultSelections,
  resetSelections,
  calculateKPIs,
  calculateScoreDistribution,
  sortStudents,
  filterStudents,
  getReportScore,
} from './teacherDashboardHelpers';
import { palette as colors } from './theme';
import { styles } from './dashboardStyles';
import { Header } from './dashboardShared';

const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'segmentation', label: 'Segments' },
  { id: 'hotspots', label: 'Hotspots' },
  { id: 'action', label: 'Action Plan' },
  { id: 'students', label: 'Reports' },
];

function FilterChip({ label, value, onPress, testID }) {
  return (
    <Pressable testID={testID || `filter-chip-${label.toLowerCase()}`} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} style={styles.filterChip} onPress={onPress}>
      <Text style={styles.filterChipLabel}>{label}: </Text>
      <Text style={styles.filterChipValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.filterChipArrow}> ▾</Text>
    </Pressable>
  );
}

function KpiCard({ label, value, trend }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {trend ? <Text style={styles.kpiTrend} numberOfLines={1}>{trend}</Text> : null}
    </View>
  );
}

function QuadrantCard({ title, subtitle, students, color }) {
  const badgeColors = {
    green: { bg: colors.successSoft, border: colors.successSoft, text: colors.success },
    blue: { bg: colors.actionTint, border: colors.actionTint, text: colors.actionPressed },
    amber: { bg: colors.cautionSoft, border: colors.cautionSoft, text: colors.caution },
    red: { bg: colors.dangerSoft, border: colors.dangerSoft, text: colors.danger },
  };
  const theme = badgeColors[color] || badgeColors.blue;

  return (
    <View style={styles.quadrantCard}>
      <View style={styles.quadrantHeader}>
        <Text style={styles.quadrantTitle}>{title}</Text>
        <Text style={styles.quadrantSubtitle} numberOfLines={1}>{subtitle}</Text>
      </View>
      <View style={styles.quadrantList}>
        {students.length ? (
          students.map((s, idx) => (
            <Text
              key={idx}
              style={[
                styles.quadrantStudent,
                { backgroundColor: theme.bg, borderColor: theme.border, color: theme.text },
              ]}
            >
              {s}
            </Text>
          ))
        ) : (
          <Text style={styles.quadrantEmpty}>None identified</Text>
        )}
      </View>
    </View>
  );
}

const SCORE_BAND_RAMP = [colors.seq1, colors.seq2, colors.seq3, colors.seq4, colors.seq5];

function ScoreDistributionChart({ distribution }) {
  const maxCount = Math.max(...distribution.map(d => d.count), 1);
  return (
    <View style={styles.chartContainer}>
      <View style={styles.chartBars}>
        {distribution.map((d, index) => {
          const heightPct = `${(d.count / maxCount) * 100}%`;
          // Sequential ramp: higher score bands read darker. Labels carry the meaning.
          const barColor = SCORE_BAND_RAMP[Math.min(index, SCORE_BAND_RAMP.length - 1)];
          return (
            <View key={d.name} style={styles.chartBarCol}>
              <View style={styles.chartBarTrack}>
                <View style={[styles.chartBarFill, { height: heightPct, backgroundColor: barColor }]} />
              </View>
              <Text style={styles.chartBarCount}>{d.count > 0 ? d.count : ''}</Text>
              <Text style={styles.chartBarLabel}>{d.name}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function SubjectAveragesChart({ percentage }) {
  const color = percentage >= 75 ? colors.success : percentage >= 45 ? colors.caution : colors.danger;
  return (
    <View style={styles.subjectAverageContainer}>
      <View style={[styles.subjectAverageCircle, { borderColor: color }]}>
        <Text style={[styles.subjectAverageText, { color }]}>{percentage}%</Text>
      </View>
      <Text style={styles.subjectAverageLabel}>Average Score across evaluated learners</Text>
    </View>
  );
}

export function AdminDashboard({
  data,
  school,
  onLogout,
  onBack,
  onOpenStudent,
  refreshing,
  onRefresh,
  tests = [],
  onLoadExamData,
  onProfile,
}) {
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedExamId, setSelectedExamId] = useState('');

  // Filtering
  const [selectedSubject, setSelectedSubject] = useState('');
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedExamType, setSelectedExamType] = useState('');
  const [selectedExamDate, setSelectedExamDate] = useState('');

  // Searching, Sorting, and Expanding
  const [studentSearch, setStudentSearch] = useState('');
  const [performanceFilter, setPerformanceFilter] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [expandedStudentUsername, setExpandedStudentUsername] = useState(null);

  // Tab State
  const [activeTab, setActiveTab] = useState('overview');
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);

  // Unified Picker state
  const [pickerConfig, setPickerConfig] = useState(null);

  // Phone layouts use a compact section menu instead of the horizontal tab strip
  const { width: windowWidth } = useWindowDimensions();
  const isCompact = windowWidth < 600;

  // API loading states
  const [examData, setExamData] = useState(null);
  const [fetchedYear, setFetchedYear] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Initialize selections from data
  useEffect(() => {
    if (data) {
      const { defaultYear, defaultExamId } = deriveDefaultSelections(data);
      setSelectedYear(curr => curr || defaultYear);
      setSelectedExamId(curr => curr || defaultExamId);
    }
  }, [data]);

  // Load exam reports when year/exam ID changes OR retry is triggered
  useEffect(() => {
    if (!onLoadExamData) return;
    if (!selectedYear && !selectedExamId) return;

    let active = true;
    setLocalLoading(true);
    setLocalError(null);

    onLoadExamData(selectedYear, selectedExamId)
      .then((res) => {
        if (active) {
          setExamData(res);
          setFetchedYear(selectedYear);
        }
      })
      .catch((err) => {
        if (active) {
          setLocalError(err.message || 'Failed to load class insights');
        }
      })
      .finally(() => {
        if (active) {
          setLocalLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedYear, selectedExamId, onLoadExamData, retryCount]);

  // When examData is updated, if selectedExamId is empty, default it to the newest exam in the newly loaded year
  useEffect(() => {
    if (examData && !selectedExamId && fetchedYear === selectedYear) {
      const academicYears = examData.academic_years || [];
      const examsList = examData.exams || [];
      const selectedYearObj = academicYears.find(y => String(y.id) === String(selectedYear));

      const filtered = examsList.filter(e => {
        if (!selectedYear || selectedYear === 'all') return true;
        if (e.academic_year_id && String(e.academic_year_id) === String(selectedYear)) return true;
        if (selectedYearObj && e.academic_year && String(e.academic_year) === String(selectedYearObj.label)) return true;
        if (String(e.academic_year_id || e.academic_year || '') === String(selectedYear)) return true;
        return false;
      });

      const defaultExam = filtered[0] || examsList[0];
      const defaultExamId = defaultExam ? (defaultExam.source_test_id || defaultExam.id) : '';
      if (defaultExamId) {
        setSelectedExamId(defaultExamId);
      }
    }
  }, [examData, selectedExamId, selectedYear, fetchedYear]);

  // Derived options lists
  const exams = useMemo(() => examData?.exams || data?.exams || [], [examData, data]);
  const academicYears = useMemo(() => examData?.academic_years || data?.academic_years || [], [examData, data]);

  const schoolSubjects = useMemo(() => {
    const present = new Set(exams.map(e => normalizeSubject(e.subject)).filter(Boolean));
    return Array.from(present).sort();
  }, [exams]);

  const schoolGrades = useMemo(() => {
    const gradesOrder = ['6th', '7th', '8th', '9th', '10th', '11th', '12th'];
    const present = new Set(exams.map(e => e.grade).filter(Boolean));
    return gradesOrder.filter(g => present.has(g));
  }, [exams]);

  const sortedExamDates = useMemo(() => {
    const dates = Array.from(new Set(exams.map(e => e.exam_date).filter(Boolean)));
    return dates.sort().reverse();
  }, [exams]);

  // Helper for applying and resetting
  const applySelections = (next) => {
    setSelectedYear(next.year);
    setSelectedSubject(next.subject);
    setSelectedGrade(next.grade);
    setSelectedExamType(next.examType);
    setSelectedExamDate(next.examDate);
    setSelectedExamId(next.examId);
  };

  const handleYearChange = (year) => {
    const next = resetSelections(exams, {
      year,
      subject: selectedSubject,
      grade: selectedGrade,
      examType: selectedExamType,
      examDate: selectedExamDate,
      examId: selectedExamId,
    }, academicYears);
    applySelections(next);
  };

  const handleSubjectChange = (subject) => {
    const next = resetSelections(exams, {
      year: selectedYear,
      subject,
      grade: selectedGrade,
      examType: selectedExamType,
      examDate: selectedExamDate,
      examId: selectedExamId,
    }, academicYears);
    applySelections(next);
  };

  const handleGradeChange = (grade) => {
    const next = resetSelections(exams, {
      year: selectedYear,
      subject: selectedSubject,
      grade,
      examType: selectedExamType,
      examDate: selectedExamDate,
      examId: selectedExamId,
    }, academicYears);
    applySelections(next);
  };

  const handleTypeChange = (examType) => {
    const next = resetSelections(exams, {
      year: selectedYear,
      subject: selectedSubject,
      grade: selectedGrade,
      examType,
      examDate: selectedExamDate,
      examId: selectedExamId,
    }, academicYears);
    applySelections(next);
  };

  const handleDateChange = (examDate) => {
    const next = resetSelections(exams, {
      year: selectedYear,
      subject: selectedSubject,
      grade: selectedGrade,
      examType: selectedExamType,
      examDate,
      examId: selectedExamId,
    }, academicYears);
    applySelections(next);
  };

  const handleExamChange = (examId) => {
    const next = resetSelections(exams, {
      year: selectedYear,
      subject: selectedSubject,
      grade: selectedGrade,
      examType: selectedExamType,
      examDate: selectedExamDate,
      examId,
    }, academicYears);
    applySelections(next);
  };

  // Derive students list and cohort metrics
  const activeCohortReport = useMemo(() => {
    return examData?.report?.cohort_reports?.[selectedExamId] || data?.report?.cohort_reports?.[selectedExamId];
  }, [examData, data, selectedExamId]);

  const studentReports = useMemo(() => {
    return examData?.studentReports || [];
  }, [examData]);

  // Derived Cohort Metrics/KPIs
  const kpis = useMemo(() => {
    return calculateKPIs(studentReports, selectedExamId, selectedSubject);
  }, [studentReports, selectedExamId, selectedSubject]);

  const filteredStudents = useMemo(() => {
    return filterStudents(studentReports, selectedExamId, selectedSubject, {
      query: studentSearch,
      classFilter: selectedGrade,
      performanceFilter,
    });
  }, [studentReports, selectedExamId, selectedSubject, studentSearch, selectedGrade, performanceFilter]);

  const scoreDistribution = useMemo(() => {
    return calculateScoreDistribution(filteredStudents, selectedExamId, selectedSubject);
  }, [filteredStudents, selectedExamId, selectedSubject]);

  const sortedStudents = useMemo(() => {
    return sortStudents(filteredStudents, sortBy, selectedExamId, selectedSubject);
  }, [filteredStudents, sortBy, selectedExamId, selectedSubject]);

  // Unique classes for Student Reports filter
  const studentClasses = useMemo(() => {
    const classes = studentReports.map(r => r.student?.class).filter(Boolean);
    return Array.from(new Set(classes)).sort();
  }, [studentReports]);

  // Reset student search/filters when exam changes
  useEffect(() => {
    setStudentSearch('');
    setPerformanceFilter('');
    setExpandedStudentUsername(null);
  }, [selectedExamId]);

  // Format Helper
  const formatDate = (dateStr) => {
    if (!dateStr) return 'All';
    try {
      const date = new Date(dateStr + 'T00:00:00');
      return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  // Setup options for the Bottom Sheet Picker
  const yearOptions = [{ label: 'All Years', value: 'all' }, ...academicYears.map(y => ({ label: y.label + (y.is_current ? ' (Current)' : ''), value: y.id }))];
  const subjectOptions = [{ label: 'All Subjects', value: '' }, ...schoolSubjects.map(s => ({ label: s, value: s }))];
  const gradeOptions = [{ label: 'All Grades', value: '' }, ...schoolGrades.map(g => ({ label: g, value: g }))];
  const typeOptions = [{ label: 'All Types', value: '' }, { label: 'MCQ', value: 'mcq' }, { label: 'Subjective', value: 'subjective' }];
  const dateOptions = [{ label: 'All Dates', value: '' }, ...sortedExamDates.map(d => ({ label: formatDate(d), value: d }))];
  const examOptions = exams
    .filter(e => (!selectedSubject || normalizeSubject(e.subject) === selectedSubject) && (!selectedGrade || e.grade === selectedGrade))
    .map(e => ({ label: e.name, value: e.source_test_id || e.id }));

  const currentYearLabel = yearOptions.find(o => o.value === selectedYear)?.label || selectedYear || 'All';
  const currentExamLabel = examOptions.find(o => o.value === selectedExamId)?.label || (exams.find(e => (e.source_test_id || e.id) === selectedExamId)?.name) || 'None';

  return (
    <View style={styles.container}>
      <Header school={school} name="Class insights" onLogout={onLogout} onBack={onBack} backLabel="Intake" onProfile={onProfile} />

      {/* Scrollable Filter Chips Bar */}
      <View style={styles.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterBarContent}>
          <FilterChip label="Year" value={currentYearLabel} onPress={() => setPickerConfig({ label: 'Year', options: yearOptions, selectedValue: selectedYear, onSelect: handleYearChange })} />
          <FilterChip label="Subject" value={selectedSubject || 'All'} onPress={() => setPickerConfig({ label: 'Subject', options: subjectOptions, selectedValue: selectedSubject, onSelect: handleSubjectChange })} />
          <FilterChip label="Grade" value={selectedGrade || 'All'} onPress={() => setPickerConfig({ label: 'Grade', options: gradeOptions, selectedValue: selectedGrade, onSelect: handleGradeChange })} />
          <FilterChip label="Type" value={selectedExamType || 'All'} onPress={() => setPickerConfig({ label: 'Type', options: typeOptions, selectedValue: selectedExamType, onSelect: handleTypeChange })} />
          <FilterChip label="Date" value={selectedExamDate ? formatDate(selectedExamDate) : 'All'} onPress={() => setPickerConfig({ label: 'Date', options: dateOptions, selectedValue: selectedExamDate, onSelect: handleDateChange })} />
          <FilterChip label="Exam" value={currentExamLabel} onPress={() => setPickerConfig({ label: 'Exam', options: examOptions, selectedValue: selectedExamId, onSelect: handleExamChange })} />
        </ScrollView>
      </View>

      {/* Section Selector: compact menu on phones, horizontal tab strip on tablets/wide screens */}
      {isCompact ? (
        <View style={styles.tabBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Section menu. Current: ${tabs.find(t => t.id === activeTab)?.label}`}
            accessibilityHint="Opens a menu of all dashboard sections"
            onPress={() => setSectionMenuOpen(true)}
            style={styles.sectionMenuTrigger}
            testID="section-menu-trigger"
          >
            <Text style={styles.sectionMenuTriggerText}>
              {tabs.find(t => t.id === activeTab)?.label}
            </Text>
            <Text style={styles.sectionMenuTriggerArrow}>▾</Text>
          </Pressable>

          <Modal visible={sectionMenuOpen} transparent animationType="fade" onRequestClose={() => setSectionMenuOpen(false)}>
            <Pressable style={styles.sectionMenuBackdrop} onPress={() => setSectionMenuOpen(false)}>
              <Pressable style={styles.sectionMenuCard} onPress={() => {}} accessibilityViewIsModal>
                <Text style={styles.sectionMenuTitle}>Jump to section</Text>
                {tabs.map((tab) => {
                  const isTabActive = activeTab === tab.id;
                  return (
                    <Pressable
                      key={tab.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isTabActive }}
                      accessibilityLabel={`${tab.label}${isTabActive ? ', current section' : ''}`}
                      style={[styles.sectionMenuItem, isTabActive && styles.sectionMenuItemActive]}
                      testID={`section-menu-item-${tab.id}`}
                      onPress={() => {
                        setActiveTab(tab.id);
                        setSectionMenuOpen(false);
                      }}
                    >
                      <Text style={[styles.sectionMenuItemText, isTabActive && styles.sectionMenuItemTextActive]}>
                        {tab.label}
                      </Text>
                      {isTabActive && <Text style={styles.sectionMenuItemCheck}>✓</Text>}
                    </Pressable>
                  );
                })}
              </Pressable>
            </Pressable>
          </Modal>
        </View>
      ) : (
        <View style={styles.tabBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {tabs.map((tab) => {
              const isTabActive = activeTab === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isTabActive }}
                  accessibilityLabel={`${tab.label}${isTabActive ? ', selected' : ''}`}
                  style={[styles.tabItem, isTabActive && styles.tabItemActive]}
                  onPress={() => setActiveTab(tab.id)}
                >
                  <Text style={[styles.tabText, isTabActive && styles.tabTextActive]}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Main Tab Contents */}
      {localLoading && !examData ? (
        <NotebookLoader size={56} style={styles.loadingSpinner} />
      ) : localError ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{localError}</Text>
          <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => setRetryCount(c => c + 1)}>
            <Text style={styles.secondaryButtonText}>Retry Loading</Text>
          </Pressable>
        </View>
      ) : !exams.length ? (
        <View style={styles.empty}>
          <Text style={styles.cardTitle}>No exams found</Text>
          <Text style={styles.body}>There are no exams matching the selected Academic Year.</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.page}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {activeTab === 'overview' && (
            <View>
              {/* KPIs Grid */}
              <View style={styles.kpiContainer}>
                <KpiCard label="Evaluated Students" value={kpis.evaluatedStudents} />
                <KpiCard label="Average Score" value={`${kpis.averagePercentage}%`} trend={kpis.averagePercentage >= 75 ? 'Strong' : kpis.averagePercentage >= 45 ? 'Developing' : 'Needs work'} />
                <KpiCard label="Pass Rate (≥35%)" value={`${kpis.passRate}%`} />
                <KpiCard label="Top Scorer" value={kpis.topScorer ? `${kpis.topScorer.score}/${kpis.topScorer.total}` : '-'} trend={kpis.topScorer?.name} />
              </View>

              {/* Subject Average Card */}
              {kpis.evaluatedStudents > 0 && (
                <View style={styles.card}>
                  <Text style={styles.sectionTitle}>Subject average</Text>
                  <SubjectAveragesChart percentage={kpis.averagePercentage} />
                </View>
              )}

              {/* Exam Context */}
              {(() => {
                const currentExamObj = exams.find(e => (e.source_test_id || e.id) === selectedExamId);
                if (!currentExamObj) return null;
                return (
                  <View style={styles.card}>
                    <Text style={styles.eyebrow}>SELECTED EXAM CONTEXT</Text>
                    <Text style={styles.cardTitle}>{currentExamObj.name}</Text>
                    <View style={styles.metricRow}>
                      <Text style={styles.metricName}>Subject</Text>
                      <Text style={styles.metricValue}>{normalizeSubject(currentExamObj.subject) || '—'}</Text>
                    </View>
                    <View style={styles.metricRow}>
                      <Text style={styles.metricName}>Grade</Text>
                      <Text style={styles.metricValue}>{currentExamObj.grade || '—'}</Text>
                    </View>
                    <View style={styles.metricRow}>
                      <Text style={styles.metricName}>Exam Date</Text>
                      <Text style={styles.metricValue}>{currentExamObj.exam_date || '—'}</Text>
                    </View>
                    <View style={styles.metricRow}>
                      <Text style={styles.metricName}>Reports Available</Text>
                      <Text style={styles.metricValue}>{studentReports.length}</Text>
                    </View>
                  </View>
                );
              })()}

              {/* Priority Gaps Section */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Priority Gaps</Text>
                {activeCohortReport?.systemic_gaps?.length ? (
                  activeCohortReport.systemic_gaps.map((gap, index) => (
                    <Text key={index} style={styles.body}>• {gap}</Text>
                  ))
                ) : (
                  <Text style={styles.body}>No priority gaps identified.</Text>
                )}
              </View>

              {/* Strengths Section */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Systemic Strengths</Text>
                {activeCohortReport?.systemic_strengths?.length ? (
                  activeCohortReport.systemic_strengths.map((str, index) => (
                    <Text key={index} style={styles.body}>• {str}</Text>
                  ))
                ) : (
                  <Text style={styles.body}>No systemic strengths identified yet.</Text>
                )}
              </View>

              {/* Intake-specific assessment-processing status as a secondary section */}
              {tests.length ? (
                <View style={styles.card}>
                  <Text style={styles.sectionTitle}>Assessment processing status</Text>
                  {tests.slice(0, 5).map((test) => (
                    <View key={test.id} style={styles.metricRow}>
                      <Text style={styles.metricName}>{test.title}</Text>
                      <Text style={styles.metricValue}>
                        {test.jobStatus ? `Processing: ${test.jobStatus}` : test.status?.replaceAll('_', ' ') || 'Draft'}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          )}

          {activeTab === 'segmentation' && (
            <View style={styles.quadrantGrid}>
              <QuadrantCard
                title="Conceptual Anchors"
                subtitle="Strong accuracy, high effort"
                students={activeCohortReport?.segmentation?.quadrant_a || []}
                color="green"
              />
              <QuadrantCard
                title="Procedural Technicians"
                subtitle="Accurate steps, context challenges"
                students={activeCohortReport?.segmentation?.quadrant_b || []}
                color="blue"
              />
              <QuadrantCard
                title="Attempting Explorers"
                subtitle="High effort, mental models needed"
                students={activeCohortReport?.segmentation?.quadrant_c || []}
                color="amber"
              />
              <QuadrantCard
                title="Foundationally Vulnerable"
                subtitle="Core remedial support needed"
                students={activeCohortReport?.segmentation?.quadrant_d || []}
                color="red"
              />
            </View>
          )}

          {activeTab === 'hotspots' && (
            <View>
              {activeCohortReport?.exam_hotspots?.length ? (
                activeCohortReport.exam_hotspots.map((h) => (
                  <View key={h.id} style={styles.hotspotCard}>
                    <View style={styles.hotspotHeader}>
                      <Text style={styles.hotspotBadge}>{h.id}</Text>
                      <Text style={styles.hotspotTitle} numberOfLines={1}>{h.title}</Text>
                      <Text style={styles.hotspotFailRate}>{h.failure_rate}</Text>
                    </View>
                    <View style={styles.hotspotBlocks}>
                      <View style={styles.hotspotCauseBlock}>
                        <Text style={styles.hotspotBlockTitle}>The Cause</Text>
                        <Text style={styles.hotspotText}>{h.why}</Text>
                      </View>
                      <View style={styles.hotspotImplicationBlock}>
                        <Text style={styles.hotspotBlockTitle}>Instructional Implication</Text>
                        <Text style={styles.hotspotText}>{h.implication}</Text>
                      </View>
                    </View>
                  </View>
                ))
              ) : (
                <View style={styles.empty}>
                  <Text style={styles.body}>No per-question analysis available yet. Hotspots appear once grading data is available.</Text>
                </View>
              )}
            </View>
          )}

          {activeTab === 'action' && (
            <View>
              {/* Immediate Curricular Adjustments */}
              <View style={styles.actionSection}>
                <Text style={styles.sectionTitle}>Immediate Curricular Adjustments</Text>
                {activeCohortReport?.interventions?.filter(i => i.type === 'immediate' || !i.type).length ? (
                  activeCohortReport.interventions.filter(i => i.type === 'immediate' || !i.type).map((inv, idx) => (
                    <View key={idx} style={styles.actionCard}>
                      <Text style={styles.actionCardTitle}>{inv.title || inv.topic}</Text>
                      <Text style={styles.actionCardText}>{inv.action || inv.description}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.body}>No immediate adjustments recommended.</Text>
                )}
              </View>

              {/* Long-term Pedagogical Shifts */}
              <View style={styles.actionSection}>
                <Text style={styles.sectionTitle}>Long-term Pedagogical Shifts</Text>
                {(() => {
                  const longTerm = activeCohortReport?.interventions?.filter(i => i.type === 'long-term') || [];
                  const followThrough = longTerm.length ? longTerm : (activeCohortReport?.interventions || []).slice(0, 3).map((item) => ({
                    ...item,
                    title: item.title || item.topic,
                    action: `${item.action || item.description || 'Use the intervention consistently.'} Track the next assessment to see whether this gap narrows.`
                  }));

                  if (!followThrough.length) {
                    return <Text style={styles.body}>No long-term pedagogical shifts recommended.</Text>;
                  }

                  return followThrough.map((inv, idx) => (
                    <View key={idx} style={[styles.actionCard, { borderLeftWidth: 4, borderLeftColor: colors.action }]}>
                      <Text style={styles.actionCardTitle}>{inv.title}</Text>
                      <Text style={styles.actionCardText}>{inv.action}</Text>
                    </View>
                  ));
                })()}
              </View>
            </View>
          )}

          {activeTab === 'students' && (
            <View>
              {/* Search, Filter, and Sort Controls */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Filter Students</Text>
                <View style={styles.studentListControls}>
                  <TextInput
                    value={studentSearch}
                    onChangeText={setStudentSearch}
                    placeholder="Search name or class"
                    placeholderTextColor={colors.muted}
                    accessibilityLabel="Search students by name or class"
                    style={styles.studentListSearch}
                  />
                  <Pressable
                    accessibilityRole="button"
                    style={styles.studentListSelect}
                    onPress={() => setPickerConfig({
                      label: 'Class Filter',
                      options: [{ label: 'All Classes', value: '' }, ...studentClasses.map(c => ({ label: c, value: c }))],
                      selectedValue: selectedGrade,
                      onSelect: handleGradeChange
                    })}
                  >
                    <Text style={styles.studentListSelectText} numberOfLines={1}>
                      {selectedGrade ? `Class: ${selectedGrade}` : 'All Classes'}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.studentListSelect}
                    onPress={() => setPickerConfig({
                      label: 'Performance Band',
                      options: [
                        { label: 'All Performance', value: '' },
                        { label: 'Strong (≥75%)', value: 'strong' },
                        { label: 'Developing (45-75%)', value: 'developing' },
                        { label: 'Needs Work (<45%)', value: 'needs-work' }
                      ],
                      selectedValue: performanceFilter,
                      onSelect: setPerformanceFilter
                    })}
                  >
                    <Text style={styles.studentListSelectText} numberOfLines={1}>
                      {performanceFilter ? `Band: ${performanceFilter}` : 'All Bands'}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.studentListSelect}
                    onPress={() => setPickerConfig({
                      label: 'Sort Students',
                      options: [
                        { label: 'Sort: Name', value: 'name' },
                        { label: 'Sort: Marks Ascending', value: 'marks-asc' },
                        { label: 'Sort: Marks Descending', value: 'marks-desc' }
                      ],
                      selectedValue: sortBy,
                      onSelect: setSortBy
                    })}
                  >
                    <Text style={styles.studentListSelectText} numberOfLines={1}>
                      {sortBy === 'name' ? 'Sort: Name' : sortBy === 'marks-asc' ? 'Sort: Score ↑' : 'Sort: Score ↓'}
                    </Text>
                  </Pressable>
                </View>
              </View>

              {/* Score Distribution Chart */}
              {filteredStudents.length > 0 && (
                <View style={styles.card}>
                  <Text style={styles.sectionTitle}>Score Distribution ({filteredStudents.length} students)</Text>
                  <ScoreDistributionChart distribution={scoreDistribution} />
                </View>
              )}

              {/* Students List */}
              {sortedStudents.length ? (
                sortedStudents.map((report) => {
                  const isExpanded = expandedStudentUsername === report.username;
                  const { score, total, pct } = getReportScore(report, selectedExamId, selectedSubject);
                  const band = pct >= 75 ? { label: 'Strong', bg: colors.successSoft, color: colors.success }
                             : pct >= 45 ? { label: 'Developing', bg: colors.cautionSoft, color: colors.caution }
                             : { label: 'Needs Work', bg: colors.dangerSoft, color: colors.danger };

                  return (
                    <Pressable
                      key={report.username}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isExpanded }}
                      accessibilityLabel={`${report.student?.name || report.username}, ${report.student?.class || 'no class'}, ${total ? `score ${score} of ${total}, ${band.label}` : 'not evaluated'}${isExpanded ? ', expanded' : ', collapsed'}`}
                      style={[styles.studentCard, isExpanded && styles.studentCardExpanded]}
                      onPress={() => setExpandedStudentUsername(isExpanded ? null : report.username)}
                    >
                      <View style={styles.studentCardHeader}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.studentCardName}>{report.student?.name || report.username}</Text>
                          <Text style={styles.studentCardClass}>
                            {report.student?.class || '-'} • {report.public_username || report.username}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <Text style={styles.studentCardScore}>{total ? `${score}/${total}` : '-'}</Text>
                          {total ? (
                            <Text style={[styles.studentBandBadge, { backgroundColor: band.bg, color: band.color }]}>
                              {band.label}
                            </Text>
                          ) : null}
                        </View>
                      </View>

                      {isExpanded && (
                        <View style={styles.expandedStudentCard}>
                          <Text style={styles.expandedStudentHeader}>Subject analysis</Text>
                          {(report.term1?.subjects || report.subjects || []).map((sub) => {
                            const subPct = sub.total > 0 ? Math.round((sub.score / sub.total) * 100) : 0;
                            const subColor = subPct >= 75 ? colors.success : subPct >= 45 ? colors.caution : colors.danger;
                            return (
                              <View key={sub.name} style={styles.expandedStudentRow}>
                                <Text style={styles.expandedStudentSubject}>{sub.name}</Text>
                                <Text style={[styles.expandedStudentScore, { color: subColor }]}>
                                  {sub.score}/{sub.total} ({subPct}%)
                                </Text>
                              </View>
                            );
                          })}
                          <Pressable
                            accessibilityRole="button"
                            style={styles.openReportButton}
                            onPress={() => onOpenStudent(report)}
                          >
                            <Text style={styles.openReportButtonText}>Show Full Report</Text>
                          </Pressable>
                        </View>
                      )}
                    </Pressable>
                  );
                })
              ) : (
                <View style={styles.empty}>
                  <Text style={styles.body}>No matching student reports found.</Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>
      )}

      {/* Unified Slider Bottom Sheet Selector Modal */}
      {pickerConfig && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPickerConfig(null)}>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPress} onPress={() => setPickerConfig(null)} />
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Select {pickerConfig.label}</Text>
                <Pressable accessibilityRole="button" onPress={() => setPickerConfig(null)}>
                  <Text style={styles.modalCloseText}>Done</Text>
                </Pressable>
              </View>
              <ScrollView style={styles.modalScroll}>
                {pickerConfig.options.map((opt) => {
                  const isSelected = opt.value === pickerConfig.selectedValue;
                  return (
                    <Pressable
                      key={opt.value}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      style={styles.modalItem}
                      testID={`picker-option-${pickerConfig.label.toLowerCase().replace(/\s+/g, '-')}-${String(opt.value).toLowerCase().replace(/\s+/g, '-')}`}
                      onPress={() => {
                        pickerConfig.onSelect(opt.value);
                        setPickerConfig(null);
                      }}
                    >
                      <Text style={[styles.modalItemText, isSelected && styles.modalItemTextActive]}>
                        {opt.label}
                      </Text>
                      {isSelected && <Text style={styles.modalCheck}>✓</Text>}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
