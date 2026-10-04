// Confirmed manual progress is independent of timer activity and executor telemetry.
export function taskProgress({completed=false,review=null,reviewReadError=false,workflow=null,workflowReadError=false,waiting=false}={}) {
 if(reviewReadError)return {state:'unknown',label:'Состояние приёмки неизвестно'};
 if(review?.reviewState==='awaiting_review')return {state:'review',label:'На приёмке'};
 if(review?.reviewState==='awaiting_dispatch')return {state:'waiting',label:'Ожидает передачи исполнителю'};
 if(review?.reviewState==='accepted'||completed)return {state:'done',label:'Завершена'};
 if(waiting||workflow?.steps?.some(s=>s.status==='blocked'))return {state:'blocked',label:'Ждёт ответа'};
 if(workflow?.steps?.some(s=>s.status==='running'))return {state:'running',label:'В работе'};
 if(workflow?.steps?.length)return {state:'planned',label:workflow.steps.every(s=>s.status==='done')?'Шаги выполнены; задача открыта':'Запланирована'};
 if(workflowReadError)return {state:'unknown',label:'Прогресс не удалось прочитать'};
 return null;
}
