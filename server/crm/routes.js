// CRM route handlers. Each receives `{ req, res, scope, input }` after the
// router has authenticated, scoped, authorised, and validated the request.
import { z } from 'zod';
import { database } from '../../api/_lib/auth.js';
import { CRM_SECTIONS } from '../../shared/crm/capabilities.js';
import { isCrmOnlyRole } from '../../shared/crm/roleDefaults.js';
import { ownRecordsOnly } from './permissions.js';
import { auditQuery, grantAccess, grantBody, listAudit, listTeam, revokeAccess, revokeBody } from './access.js';
import {
  checkDuplicates, createLead, createLeadBody, duplicatesQuery, getLead, leadQuery, listLeadOwners, listLeads, listLeadsQuery,
  moveLeadBody, moveLeadStage, setLeadOwner, setOwnerBody, updateLead, updateLeadBody,
} from './leads.js';
import {
  addGuardian, addGuardianBody, guardianLinkBody, guardiansQuery, listGuardians, makePrimaryGuardian, removeGuardian, updateContact,
  updateContactBody, updateGuardian, updateGuardianBody,
} from './guardians.js';
import {
  getStudent, listStudentBatches, listStudentOwners, listStudents, listStudentsQuery, setStudentOwner, setStudentOwnerBody, studentQuery,
} from './students.js';
import { addNote, addNoteBody, editNote, editNoteBody, listNotes, listNotesQuery, removeNote, removeNoteBody } from './notes.js';
import { listQuery } from './pagination.js';
import {
  applyTag, applyTagBody, archiveTag, archiveTagBody, createTag, createTagBody, listTags, listTagsQuery, removeTag, removeTagBody,
  updateTag, updateTagBody,
} from './tags.js';
import { getTimeline, timelineQuery } from './timeline.js';
import {
  getInquirySettings, getPublicInquiry, inquirySettingsBody, inquirySettingsQuery, publicInquiryQuery, submitPublicInquiry, updateInquirySettings,
} from './inquiry.js';
import { conversionPreview, conversionQuery, convertLead, convertLeadBody } from './conversion.js';
import {
  addBatchStudents, addBatchStudentsBody, archiveBatch, archiveBatchBody, batchCourseBody, batchQuery, batchStudentsQuery, classesOptions,
  createBatch, createBatchBody, getBatch, listBatches, listBatchesQuery, listBatchStudents, removeBatchStudent, removeBatchStudentBody,
  setBatchCourse, updateBatch, updateBatchBody,
} from './batches.js';
import {
  archiveCourse, courseStatusBody, createCourse, createCourseBody, listCourses, listCoursesQuery, restoreCourse, updateCourse, updateCourseBody,
} from './courses.js';
import {
  addException, assignInstructor, assignInstructorBody, assignmentBody, availabilityBody, availabilityQuery, batchInstructorsQuery, endAssignment,
  exceptionBody, getAvailability, listBatchInstructors, listInstructors, makeLead, removeException, removeExceptionBody, setAvailability,
} from './instructors.js';
import {
  cancelSession, cancelSessionBody, createOneOffSession, createRule, createRuleBody, endRule, endRuleBody, listRules, listSessions, oneOffSessionBody,
  restoreSession, restoreSessionBody, rulesQuery, sessionsQuery, updateRule, updateRuleBody, updateSession, updateSessionBody,
} from './timetable.js';
import {
  attendancePending, attendanceToday, batchRegister, batchSummary, batchSummaryQuery, getSheet, markAttendance, markBody, registerQuery, sheetQuery,
  studentSummary, studentSummaryQuery, todayQuery,
} from './attendance.js';
import {
  archivePlan, createPlan, createPlanBody, feeSettingsBody, getFeeSettings, listPlans, listPlansQuery, planStatusBody, restorePlan, saveFeeSettings,
  updatePlan, updatePlanBody,
} from './feePlans.js';
import {
  applyBody, applyFees, correctInvoice, correctInvoiceBody, createInvoice, duesQuery, listDues, manualInvoiceBody, previewFees, previewQuery,
  stopFutureBody, stopFutureFees, voidInvoice, voidInvoiceBody,
} from './invoices.js';
import { invoicePdf, invoicePdfQuery, receiptPdf, receiptPdfQuery } from './feeDocuments.js';
import {
  connectBody, connectManualBody, connectWhatsApp, connectWhatsAppManual, connectWhatsAppTest, disconnectBody, disconnectWhatsApp, getWhatsApp,
  getWhatsAppUsage, refreshWhatsAppTemplates, saveWhatsAppSettings, waSettingsBody,
} from './whatsapp.js';
import { composeQuery, getCompose, retryBody, retryMessage, sendMessage, sendMessageBody } from './messages.js';
import {
  commsStatus, groupFiltersQuery, groupOptions, groupSendBody, historyQuery, listMessages, listReplies, previewGroup, repliesQuery, sendGroup,
} from './commsHistory.js';
import {
  getReminders, pauseBody, pauseReminders, reminderQuery, revokeFeeLinks, revokeLinksBody, sendReminder, sendReminderBody,
} from './feeMessages.js';
import { getPublicFees, getPublicInvoicePdf, getPublicReceiptPdf, publicFeesQuery, publicInvoiceQuery, publicReceiptQuery } from './parentFees.js';
import { receiveWebhook, verifyWebhook, webhookQuery } from './whatsappWebhook.js';
import {
  listPayments, moveAllocation, moveAllocationBody, paymentsQuery, recordPayment, recordPaymentBody, reversePayment, reversePaymentBody, studentFees,
  studentFeesQuery,
} from './payments.js';
import { addHoliday, holidayBody, holidayImpact, holidayImpactQuery, listHolidays, removeHoliday, removeHolidayBody } from './holidays.js';
import {
  archiveRoom, createRoom, createRoomBody, listRooms, listRoomsQuery, restoreRoom, roomStatusBody, updateRoom, updateRoomBody,
} from './rooms.js';
import {
  addStage, addStageBody, archiveStage, archiveStageBody, getPipeline, renameStage, renameStageBody, reorderStages, reorderStagesBody,
  requirementsBody, updateRequirements,
} from './pipeline.js';
import {
  cancelTask, completeTask, createTask, createTaskBody, listTaskAssignees, listTasks, listTasksQuery, reassignTask, reassignTaskBody,
  reopenTask, rescheduleTask, rescheduleTaskBody, taskScope, taskStatusBody, taskSummary,
} from './tasks.js';
import { listReports, getReportDetail, extendedStudentDetail, reportListQuery, detailQuery } from './reports.js';

function me({ scope }) {
  const capabilities = [...scope.capabilities].sort();
  return {
    user: { id: scope.actor.user_id || null, username: scope.actor.username || null, role: scope.actor.role },
    school: { id: scope.schoolId, name: scope.schoolName || null, timezone: scope.timezone },
    capabilities,
    sections: CRM_SECTIONS.filter((section) => scope.capabilities.has(section.capability)).map((section) => section.key),
    support: scope.support,
    // 'own' when tasks are limited to the user's own (teachers by default).
    taskScope: scope.capabilities.has('crm.tasks.read') ? taskScope(scope) : null,
    // 'own' when attendance marking is limited to the user's classes (teachers by default, D3).
    attendanceScope: scope.capabilities.has('crm.attendance.write') ? (ownRecordsOnly(scope, 'crm.attendance.write') ? 'own' : 'school') : null,
    // Office staff can only use the CRM, so links to the report pages are hidden for them.
    crmOnly: isCrmOnlyRole(scope.actor.role),
  };
}

// School picker for platform staff. Small list, so a single page is returned
// in the standard list shape.
async function schools() {
  const result = await database().execute({
    sql: `SELECT s.id, s.slug, s.display_name,
                 COALESCE(MAX(CASE WHEN f.feature_key = 'crm' THEN f.enabled END), 0) AS crm_enabled
          FROM schools s
          LEFT JOIN school_feature_flags f ON f.school_id = s.id
          WHERE s.status = 'active'
          GROUP BY s.id, s.slug, s.display_name
          ORDER BY s.display_name`,
    args: [],
  });
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.display_name,
      crmEnabled: Number(row.crm_enabled) === 1,
    })),
    nextCursor: null,
  };
}

const empty = z.object({}).passthrough();

// `platform: true` routes are for skyll_admin only and run without a school.
export const CRM_ROUTES = [
  { method: 'GET', path: 'me', capability: 'crm.access', query: empty, handler: me },
  { method: 'GET', path: 'schools', platform: true, query: empty, handler: schools },
  { method: 'GET', path: 'permissions/team', capability: 'crm.permissions.manage', query: listQuery, handler: listTeam },
  { method: 'POST', path: 'permissions/grants', capability: 'crm.permissions.manage', body: grantBody, idempotent: true, handler: grantAccess },
  { method: 'POST', path: 'permissions/revoke', capability: 'crm.permissions.manage', body: revokeBody, idempotent: true, handler: revokeAccess },
  { method: 'GET', path: 'audit', capability: 'crm.audit.read', query: auditQuery, handler: listAudit },
  // Stage names and order are not sensitive; every CRM user can read them.
  { method: 'GET', path: 'settings/pipeline', capability: 'crm.access', query: empty, handler: getPipeline },
  { method: 'POST', path: 'settings/pipeline/rename', capability: 'crm.settings.manage', body: renameStageBody, idempotent: true, handler: renameStage },
  { method: 'POST', path: 'settings/pipeline/stages', capability: 'crm.settings.manage', body: addStageBody, idempotent: true, handler: addStage },
  { method: 'POST', path: 'settings/pipeline/archive', capability: 'crm.settings.manage', body: archiveStageBody, idempotent: true, handler: archiveStage },
  { method: 'POST', path: 'settings/pipeline/requirements', capability: 'crm.settings.manage', body: requirementsBody, idempotent: true, handler: updateRequirements },
  // Conversion also checks crm.students.read in the handler (candidates name students).
  { method: 'GET', path: 'leads/conversion', capability: 'crm.leads.convert', query: conversionQuery, handler: conversionPreview },
  { method: 'POST', path: 'leads/convert', capability: 'crm.leads.convert', body: convertLeadBody, idempotent: true, handler: convertLead },
  { method: 'POST', path: 'settings/pipeline/reorder', capability: 'crm.settings.manage', body: reorderStagesBody, idempotent: true, handler: reorderStages },
  { method: 'GET', path: 'leads', capability: 'crm.leads.read', query: listLeadsQuery, handler: listLeads },
  { method: 'POST', path: 'leads', capability: 'crm.leads.write', body: createLeadBody, idempotent: true, status: 201, handler: createLead },
  { method: 'POST', path: 'leads/stage', capability: 'crm.leads.write', body: moveLeadBody, idempotent: true, handler: moveLeadStage },
  { method: 'GET', path: 'leads/detail', capability: 'crm.leads.read', query: leadQuery, handler: getLead },
  { method: 'GET', path: 'leads/duplicates', capability: 'crm.leads.write', query: duplicatesQuery, handler: checkDuplicates },
  { method: 'GET', path: 'leads/owners', capability: 'crm.leads.read', query: empty, handler: listLeadOwners },
  { method: 'POST', path: 'leads/owner', capability: 'crm.leads.write', body: setOwnerBody, idempotent: true, handler: setLeadOwner },
  { method: 'GET', path: 'tasks', capability: 'crm.tasks.read', query: listTasksQuery, handler: listTasks },
  { method: 'GET', path: 'tasks/summary', capability: 'crm.tasks.read', query: empty, handler: taskSummary },
  { method: 'GET', path: 'tasks/assignees', capability: 'crm.tasks.write', query: empty, handler: listTaskAssignees },
  { method: 'POST', path: 'tasks', capability: 'crm.tasks.write', body: createTaskBody, idempotent: true, status: 201, handler: createTask },
  { method: 'POST', path: 'tasks/complete', capability: 'crm.tasks.write', body: taskStatusBody, idempotent: true, handler: completeTask },
  { method: 'POST', path: 'tasks/reopen', capability: 'crm.tasks.write', body: taskStatusBody, idempotent: true, handler: reopenTask },
  { method: 'POST', path: 'tasks/cancel', capability: 'crm.tasks.write', body: taskStatusBody, idempotent: true, handler: cancelTask },
  { method: 'POST', path: 'tasks/reschedule', capability: 'crm.tasks.write', body: rescheduleTaskBody, idempotent: true, handler: rescheduleTask },
  { method: 'POST', path: 'tasks/reassign', capability: 'crm.tasks.write', body: reassignTaskBody, idempotent: true, handler: reassignTask },
  // Notes, tags and timelines check lead or student access per record in the handler.
  { method: 'GET', path: 'notes', capability: 'crm.access', query: listNotesQuery, handler: listNotes },
  { method: 'POST', path: 'notes', capability: 'crm.access', body: addNoteBody, idempotent: true, status: 201, handler: addNote },
  { method: 'POST', path: 'notes/update', capability: 'crm.access', body: editNoteBody, idempotent: true, handler: editNote },
  { method: 'POST', path: 'notes/remove', capability: 'crm.access', body: removeNoteBody, idempotent: true, handler: removeNote },
  { method: 'GET', path: 'timeline', capability: 'crm.access', query: timelineQuery, handler: getTimeline },
  // Tag names are school configuration, readable by every CRM user.
  { method: 'GET', path: 'tags', capability: 'crm.access', query: listTagsQuery, handler: listTags },
  { method: 'POST', path: 'tags/apply', capability: 'crm.access', body: applyTagBody, idempotent: true, handler: applyTag },
  { method: 'POST', path: 'tags/remove', capability: 'crm.access', body: removeTagBody, idempotent: true, handler: removeTag },
  { method: 'POST', path: 'settings/tags', capability: 'crm.settings.manage', body: createTagBody, idempotent: true, status: 201, handler: createTag },
  { method: 'POST', path: 'settings/tags/update', capability: 'crm.settings.manage', body: updateTagBody, idempotent: true, handler: updateTag },
  { method: 'POST', path: 'settings/tags/archive', capability: 'crm.settings.manage', body: archiveTagBody, idempotent: true, handler: archiveTag },
  { method: 'GET', path: 'students', capability: 'crm.students.read', query: listStudentsQuery, handler: listStudents },
  { method: 'GET', path: 'students/detail', capability: 'crm.students.read', query: studentQuery, handler: getStudent },
  { method: 'GET', path: 'students/progress', capability: 'crm.progress.read', query: studentQuery, handler: extendedStudentDetail },
  { method: 'GET', path: 'students/batches', capability: 'crm.students.read', query: empty, handler: listStudentBatches },
  { method: 'GET', path: 'students/owners', capability: 'crm.students.read', query: empty, handler: listStudentOwners },
  { method: 'POST', path: 'students/owner', capability: 'crm.students.write', body: setStudentOwnerBody, idempotent: true, handler: setStudentOwner },
  { method: 'GET', path: 'students/progress', capability: 'crm.progress.read', query: studentQuery, handler: extendedStudentDetail },
  // Reports: published assessment reports, canonical-only reads.
  { method: 'GET', path: 'reports/list', capability: 'crm.reports.read', query: reportListQuery, handler: listReports },
  { method: 'GET', path: 'reports/detail', capability: 'crm.reports.read', query: detailQuery, handler: getReportDetail },
  // Guardians are contact data: the handlers also require crm.contacts.read / write.
  { method: 'GET', path: 'students/guardians', capability: 'crm.students.read', query: guardiansQuery, handler: listGuardians },
  { method: 'POST', path: 'students/guardians', capability: 'crm.students.read', body: addGuardianBody, idempotent: true, status: 201, handler: addGuardian },
  { method: 'POST', path: 'students/guardians/update', capability: 'crm.students.read', body: updateGuardianBody, idempotent: true, handler: updateGuardian },
  { method: 'POST', path: 'students/guardians/primary', capability: 'crm.students.read', body: guardianLinkBody, idempotent: true, handler: makePrimaryGuardian },
  { method: 'POST', path: 'students/guardians/remove', capability: 'crm.students.read', body: guardianLinkBody, idempotent: true, handler: removeGuardian },
  { method: 'POST', path: 'contacts/update', capability: 'crm.contacts.write', body: updateContactBody, idempotent: true, handler: updateContact },
  { method: 'POST', path: 'leads/update', capability: 'crm.leads.write', body: updateLeadBody, idempotent: true, handler: updateLead },
  { method: 'GET', path: 'settings/inquiry', capability: 'crm.settings.manage', query: inquirySettingsQuery, handler: getInquirySettings },
  { method: 'POST', path: 'settings/inquiry', capability: 'crm.settings.manage', body: inquirySettingsBody, idempotent: true, handler: updateInquirySettings },
  // Classes (FLKRM-327). Reading is school-wide for anyone with classes read;
  // every change needs classes write. Adding students also checks students read.
  { method: 'GET', path: 'classes/options', capability: 'crm.classes.read', query: empty, handler: classesOptions },
  { method: 'GET', path: 'classes/courses', capability: 'crm.classes.read', query: listCoursesQuery, handler: listCourses },
  { method: 'POST', path: 'classes/courses', capability: 'crm.classes.write', body: createCourseBody, idempotent: true, status: 201, handler: createCourse },
  { method: 'POST', path: 'classes/courses/update', capability: 'crm.classes.write', body: updateCourseBody, idempotent: true, handler: updateCourse },
  { method: 'POST', path: 'classes/courses/archive', capability: 'crm.classes.write', body: courseStatusBody, idempotent: true, handler: archiveCourse },
  { method: 'POST', path: 'classes/courses/restore', capability: 'crm.classes.write', body: courseStatusBody, idempotent: true, handler: restoreCourse },
  { method: 'GET', path: 'classes/batches', capability: 'crm.classes.read', query: listBatchesQuery, handler: listBatches },
  { method: 'GET', path: 'classes/batches/detail', capability: 'crm.classes.read', query: batchQuery, handler: getBatch },
  { method: 'POST', path: 'classes/batches', capability: 'crm.classes.write', body: createBatchBody, idempotent: true, status: 201, handler: createBatch },
  { method: 'POST', path: 'classes/batches/update', capability: 'crm.classes.write', body: updateBatchBody, idempotent: true, handler: updateBatch },
  { method: 'POST', path: 'classes/batches/course', capability: 'crm.classes.write', body: batchCourseBody, idempotent: true, handler: setBatchCourse },
  { method: 'POST', path: 'classes/batches/archive', capability: 'crm.classes.write', body: archiveBatchBody, idempotent: true, handler: archiveBatch },
  { method: 'GET', path: 'classes/batches/students', capability: 'crm.classes.read', query: batchStudentsQuery, handler: listBatchStudents },
  { method: 'POST', path: 'classes/batches/students/add', capability: 'crm.classes.write', body: addBatchStudentsBody, idempotent: true, handler: addBatchStudents },
  { method: 'POST', path: 'classes/batches/students/remove', capability: 'crm.classes.write', body: removeBatchStudentBody, idempotent: true, handler: removeBatchStudent },
  { method: 'GET', path: 'classes/instructors', capability: 'crm.classes.read', query: empty, handler: listInstructors },
  { method: 'GET', path: 'classes/batches/instructors', capability: 'crm.classes.read', query: batchInstructorsQuery, handler: listBatchInstructors },
  { method: 'POST', path: 'classes/batches/instructors', capability: 'crm.classes.write', body: assignInstructorBody, idempotent: true, status: 201, handler: assignInstructor },
  { method: 'POST', path: 'classes/batches/instructors/end', capability: 'crm.classes.write', body: assignmentBody, idempotent: true, handler: endAssignment },
  { method: 'POST', path: 'classes/batches/instructors/lead', capability: 'crm.classes.write', body: assignmentBody, idempotent: true, handler: makeLead },
  // Availability: a teacher may change their own; anyone else's needs classes write (checked in the handler).
  { method: 'GET', path: 'classes/availability', capability: 'crm.classes.read', query: availabilityQuery, handler: getAvailability },
  { method: 'POST', path: 'classes/availability', capability: 'crm.classes.read', body: availabilityBody, idempotent: true, handler: setAvailability },
  { method: 'POST', path: 'classes/availability/exceptions', capability: 'crm.classes.read', body: exceptionBody, idempotent: true, status: 201, handler: addException },
  { method: 'POST', path: 'classes/availability/exceptions/remove', capability: 'crm.classes.read', body: removeExceptionBody, idempotent: true, handler: removeException },
  { method: 'GET', path: 'classes/rules', capability: 'crm.classes.read', query: rulesQuery, handler: listRules },
  { method: 'POST', path: 'classes/rules', capability: 'crm.classes.write', body: createRuleBody, idempotent: true, status: 201, handler: createRule },
  { method: 'POST', path: 'classes/rules/update', capability: 'crm.classes.write', body: updateRuleBody, idempotent: true, handler: updateRule },
  { method: 'POST', path: 'classes/rules/end', capability: 'crm.classes.write', body: endRuleBody, idempotent: true, handler: endRule },
  { method: 'GET', path: 'classes/sessions', capability: 'crm.classes.read', query: sessionsQuery, handler: listSessions },
  { method: 'POST', path: 'classes/sessions', capability: 'crm.classes.write', body: oneOffSessionBody, idempotent: true, status: 201, handler: createOneOffSession },
  { method: 'POST', path: 'classes/sessions/cancel', capability: 'crm.classes.write', body: cancelSessionBody, idempotent: true, handler: cancelSession },
  { method: 'POST', path: 'classes/sessions/restore', capability: 'crm.classes.write', body: restoreSessionBody, idempotent: true, handler: restoreSession },
  { method: 'POST', path: 'classes/sessions/update', capability: 'crm.classes.write', body: updateSessionBody, idempotent: true, handler: updateSession },
  { method: 'GET', path: 'classes/holidays', capability: 'crm.classes.read', query: empty, handler: listHolidays },
  { method: 'GET', path: 'classes/holidays/impact', capability: 'crm.classes.write', query: holidayImpactQuery, handler: holidayImpact },
  { method: 'POST', path: 'classes/holidays', capability: 'crm.classes.write', body: holidayBody, idempotent: true, status: 201, handler: addHoliday },
  { method: 'POST', path: 'classes/holidays/remove', capability: 'crm.classes.write', body: removeHolidayBody, idempotent: true, handler: removeHoliday },
  // Attendance (D3, D8–D10). Marking re-checks own class, day and lock in the handler.
  { method: 'GET', path: 'attendance/sheet', capability: 'crm.attendance.read', query: sheetQuery, handler: getSheet },
  { method: 'POST', path: 'attendance/mark', capability: 'crm.attendance.write', body: markBody, idempotent: true, handler: markAttendance },
  { method: 'GET', path: 'attendance/today', capability: 'crm.attendance.read', query: todayQuery, handler: attendanceToday },
  { method: 'GET', path: 'attendance/pending', capability: 'crm.attendance.read', query: empty, handler: attendancePending },
  // Summaries (D11). The student summary also checks students read (assertRecord).
  { method: 'GET', path: 'attendance/student-summary', capability: 'crm.attendance.read', query: studentSummaryQuery, handler: studentSummary },
  { method: 'GET', path: 'attendance/batch-summary', capability: 'crm.attendance.read', query: batchSummaryQuery, handler: batchSummary },
  { method: 'GET', path: 'attendance/register', capability: 'crm.attendance.read', query: registerQuery, handler: batchRegister },
  // Fees (CRM M2 phase 1, D7): finance read to see, finance write to change.
  { method: 'GET', path: 'fees/plans', capability: 'crm.finance.read', query: listPlansQuery, handler: listPlans },
  { method: 'POST', path: 'fees/plans', capability: 'crm.finance.write', body: createPlanBody, idempotent: true, status: 201, handler: createPlan },
  { method: 'POST', path: 'fees/plans/update', capability: 'crm.finance.write', body: updatePlanBody, idempotent: true, handler: updatePlan },
  { method: 'POST', path: 'fees/plans/archive', capability: 'crm.finance.write', body: planStatusBody, idempotent: true, handler: archivePlan },
  { method: 'POST', path: 'fees/plans/restore', capability: 'crm.finance.write', body: planStatusBody, idempotent: true, handler: restorePlan },
  { method: 'GET', path: 'fees/preview', capability: 'crm.finance.write', query: previewQuery, handler: previewFees },
  { method: 'POST', path: 'fees/apply', capability: 'crm.finance.write', body: applyBody, idempotent: true, status: 201, handler: applyFees },
  { method: 'POST', path: 'fees/invoices', capability: 'crm.finance.write', body: manualInvoiceBody, idempotent: true, status: 201, handler: createInvoice },
  { method: 'POST', path: 'fees/invoices/void', capability: 'crm.finance.write', body: voidInvoiceBody, idempotent: true, handler: voidInvoice },
  { method: 'POST', path: 'fees/invoices/correct', capability: 'crm.finance.write', body: correctInvoiceBody, idempotent: true, status: 201, handler: correctInvoice },
  { method: 'POST', path: 'fees/invoices/stop-future', capability: 'crm.finance.write', body: stopFutureBody, idempotent: true, handler: stopFutureFees },
  { method: 'GET', path: 'fees/student', capability: 'crm.finance.read', query: studentFeesQuery, handler: studentFees },
  { method: 'POST', path: 'fees/payments', capability: 'crm.finance.write', body: recordPaymentBody, idempotent: true, status: 201, handler: recordPayment },
  { method: 'GET', path: 'fees/payments', capability: 'crm.finance.read', query: paymentsQuery, handler: listPayments },
  { method: 'POST', path: 'fees/payments/reverse', capability: 'crm.finance.write', body: reversePaymentBody, idempotent: true, handler: reversePayment },
  // PDFs (S4): written straight to the response as application/pdf.
  { method: 'GET', path: 'fees/invoices/pdf', capability: 'crm.finance.read', query: invoicePdfQuery, handler: invoicePdf },
  { method: 'GET', path: 'fees/payments/receipt', capability: 'crm.finance.read', query: receiptPdfQuery, handler: receiptPdf },
  { method: 'POST', path: 'fees/allocations/move', capability: 'crm.finance.write', body: moveAllocationBody, idempotent: true, handler: moveAllocation },
  { method: 'GET', path: 'fees/dues', capability: 'crm.finance.read', query: duesQuery, handler: listDues },
  // Fee reminders (CRM M2 phase 2 S3, D7/D10). Sending also needs finance read (checked in the handler).
  { method: 'GET', path: 'fees/reminders', capability: 'crm.finance.read', query: reminderQuery, handler: getReminders },
  { method: 'POST', path: 'fees/reminders/send', capability: 'crm.comms.send', body: sendReminderBody, idempotent: true, handler: sendReminder },
  { method: 'POST', path: 'fees/reminders/pause', capability: 'crm.finance.write', body: pauseBody, idempotent: true, handler: pauseReminders },
  { method: 'POST', path: 'fees/links/revoke', capability: 'crm.finance.write', body: revokeLinksBody, idempotent: true, handler: revokeFeeLinks },
  { method: 'GET', path: 'settings/fees', capability: 'crm.settings.manage', query: empty, handler: getFeeSettings },
  { method: 'POST', path: 'settings/fees', capability: 'crm.settings.manage', body: feeSettingsBody, idempotent: true, handler: saveFeeSettings },
  // WhatsApp (CRM M2 phase 2, D2/D11): admins connect the class's own number.
  // Manual and test connections also require platform staff (checked in the handler).
  { method: 'GET', path: 'settings/whatsapp', capability: 'crm.settings.manage', query: empty, handler: getWhatsApp },
  { method: 'POST', path: 'settings/whatsapp', capability: 'crm.settings.manage', body: waSettingsBody, idempotent: true, handler: saveWhatsAppSettings },
  { method: 'POST', path: 'settings/whatsapp/connect', capability: 'crm.settings.manage', body: connectBody, idempotent: true, handler: connectWhatsApp },
  { method: 'POST', path: 'settings/whatsapp/connect-manual', capability: 'crm.settings.manage', body: connectManualBody, idempotent: true, handler: connectWhatsAppManual },
  { method: 'POST', path: 'settings/whatsapp/connect-test', capability: 'crm.settings.manage', body: empty, idempotent: true, handler: connectWhatsAppTest },
  { method: 'POST', path: 'settings/whatsapp/disconnect', capability: 'crm.settings.manage', body: disconnectBody, idempotent: true, handler: disconnectWhatsApp },
  { method: 'POST', path: 'settings/whatsapp/templates/refresh', capability: 'crm.settings.manage', body: empty, idempotent: true, handler: refreshWhatsAppTemplates },
  { method: 'GET', path: 'settings/whatsapp/usage', capability: 'crm.settings.manage', query: empty, handler: getWhatsAppUsage },
  // Messages (D8/D11). Handlers also check record access, and teachers' own batches.
  { method: 'GET', path: 'messages/compose', capability: 'crm.comms.send', query: composeQuery, handler: getCompose },
  { method: 'POST', path: 'messages', capability: 'crm.comms.send', body: sendMessageBody, idempotent: true, status: 201, handler: sendMessage },
  { method: 'POST', path: 'messages/retry', capability: 'crm.comms.send', body: retryBody, idempotent: true, handler: retryMessage },
  // Communications page (S5): history, replies and group notices; teachers see their own batches only.
  { method: 'GET', path: 'messages', capability: 'crm.comms.read', query: historyQuery, handler: listMessages },
  { method: 'GET', path: 'messages/replies', capability: 'crm.comms.read', query: repliesQuery, handler: listReplies },
  { method: 'GET', path: 'messages/status', capability: 'crm.comms.read', query: empty, handler: commsStatus },
  { method: 'GET', path: 'messages/group/options', capability: 'crm.comms.send', query: empty, handler: groupOptions },
  { method: 'GET', path: 'messages/group/preview', capability: 'crm.comms.send', query: groupFiltersQuery, handler: previewGroup },
  { method: 'POST', path: 'messages/group', capability: 'crm.comms.send', body: groupSendBody, idempotent: true, status: 201, handler: sendGroup },
  { method: 'GET', path: 'classes/rooms', capability: 'crm.classes.read', query: listRoomsQuery, handler: listRooms },
  { method: 'POST', path: 'classes/rooms', capability: 'crm.classes.write', body: createRoomBody, idempotent: true, status: 201, handler: createRoom },
  { method: 'POST', path: 'classes/rooms/update', capability: 'crm.classes.write', body: updateRoomBody, idempotent: true, handler: updateRoom },
  { method: 'POST', path: 'classes/rooms/archive', capability: 'crm.classes.write', body: roomStatusBody, idempotent: true, handler: archiveRoom },
  { method: 'POST', path: 'classes/rooms/restore', capability: 'crm.classes.write', body: roomStatusBody, idempotent: true, handler: restoreRoom },
  // No login: the handler resolves the school from `?school=<slug>` and validates the body itself (D8, D9).
  { method: 'GET', path: 'public/inquiry', public: true, query: publicInquiryQuery, handler: getPublicInquiry },
  { method: 'POST', path: 'public/inquiry', public: true, query: publicInquiryQuery, handler: submitPublicInquiry },
  // The parent fees page: a hashed, expiring, rate-limited link from a WhatsApp message (D10).
  { method: 'GET', path: 'public/fees', public: true, query: publicFeesQuery, handler: getPublicFees },
  { method: 'GET', path: 'public/fees/invoice', public: true, query: publicInvoiceQuery, handler: getPublicInvoicePdf },
  { method: 'GET', path: 'public/fees/receipt', public: true, query: publicReceiptQuery, handler: getPublicReceiptPdf },
  // Meta's webhook: GET verifies the URL once; POST is signed with the app secret (checked in the handler).
  { method: 'GET', path: 'public/whatsapp/webhook', public: true, query: webhookQuery, handler: verifyWebhook },
  { method: 'POST', path: 'public/whatsapp/webhook', public: true, query: webhookQuery, handler: receiveWebhook },
];
