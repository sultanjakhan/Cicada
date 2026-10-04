// Confirmed manual progress is independent of timer activity and executor telemetry.
export function taskProgress({language='ru',completed=false,review=null,reviewReadError=false,workflow=null,workflowReadError=false,waiting=false}={}) {
 const text=(ru,en)=>language.toLowerCase().startsWith('en')?en:ru;
 if(reviewReadError)return {state:'unknown',label:text('Состояние приёмки неизвестно', 'Review status unknown')};
 if(review?.reviewState==='awaiting_review')return {state:'review',label:text('На приёмке', 'Under review')};
 if(review?.reviewState==='awaiting_dispatch')return {state:'waiting',label:text('Ожидает передачи исполнителю', 'Awaiting dispatch')};
 if(review?.reviewState==='running')return {state:'running',label:text('В работе · подтверждено исполнителем', 'In progress · confirmed by executor')};
 if(review?.reviewState==='accepted'||completed)return {state:'done',label:text('Завершена', 'Completed')};
 if(waiting||workflow?.steps?.some(s=>s.status==='blocked'))return {state:'blocked',label:text('Ждёт ответа', 'Waiting for a response')};
 if(workflow?.steps?.some(s=>s.status==='running'))return {state:'running',label:text('В работе', 'In progress')};
 if(workflow?.steps?.length)return {state:'planned',label:workflow.steps.every(s=>s.status==='done')?text('Шаги выполнены; задача открыта', 'Steps completed; task still open'):text('Запланирована', 'Planned')};
 if(workflowReadError)return {state:'unknown',label:text('Прогресс не удалось прочитать', 'Could not read progress')};
 return null;
}
